window.CodegraphHooks = window.CodegraphHooks || {};

// Loaded before graph_layout.js and graph_hook.js — pure label/formatting
// helpers and the handful of constants + toggle state both the layout
// algorithm and the DOM renderer need. Everything here is free of d3/DOM
// dependencies so it can be reasoned about (and tested) in isolation from
// either of those two.

function cgNodeId(n) {
  return n.function ? n.module + "." + n.function + "/" + n.arity : n.module;
}

function cgTruncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Elixir @spec commonly labels its own argument ("message :: Message.t()")
// which would be redundant next to the def head's own param name of the
// same thing — this keeps just the type half.
function cgSpecType(specArg) {
  var i = specArg.indexOf("::");
  return i === -1 ? specArg : specArg.slice(i + 2).trim();
}

// Node color alone doesn't reliably identify a module: the palette
// (d3.schemeTableau10) only has 10 distinct colors, and any scope with
// more than 10 modules — which is most real ones — has to reuse colors,
// so two different modules can land on the same one. The module name is
// shown as its own small line above the signature (see the node text
// rendering in graph_hook.js) rather than prefixed onto the function name
// itself, which made that line too long.
function cgModuleShort(mod) {
  var parts = mod.split(".");
  return parts[parts.length - 1];
}

// Parameter names always come from the def head itself (no static types
// required for that). @spec input/output types are layered on top only
// when present — most functions won't have one, since @spec is optional
// idiomatic Elixir, not mandatory. Always shown on the graph now (not a
// hover tooltip), so this also drives each node's on-screen footprint —
// see graph_layout.js's nodeSize callback, which sizes each node's slot
// from these same lines rather than a fixed guess.
function cgLabelLines(info) {
  if (!info.params) return [info.function + "/" + info.arity];

  var paramList = info.params
    .map(function (p, i) {
      var specArg = info.spec_args && info.spec_args[i];
      return specArg ? p + ": " + cgSpecType(specArg) : p;
    })
    .join(", ");

  var lines = [cgTruncate(info.function + "(" + paramList + ")", 64)];
  if (info.spec_return) lines.push(cgTruncate(":: " + info.spec_return, 64));
  return lines;
}

var CG_CHAR_WIDTH = 6.6; // approx px/char for the 11px ui-monospace label font

function cgLabelWidth(info) {
  var lines = cgLabelLines(info).concat([cgModuleShort(info.module)]);
  var maxLen = lines.reduce(function (m, l) {
    return Math.max(m, l.length);
  }, 0);
  return maxLen * CG_CHAR_WIDTH + 34; // +34 for the node circle + left gap
}

// A box's own label (its full module name, shown once at the box's
// top-left — see graph_hook.js) can be wider than every one of its member
// nodes' own cgLabelWidth (a deeply nested module name next to a short
// function name/arity, say). Shared by both the box-aware contour layout
// in graph_layout.js (which must reserve enough horizontal space to avoid
// a neighboring box) and the actual rectangle drawn later in
// graph_hook.js — using the same formula in both places is what keeps a
// box's drawn width from silently exceeding what was reserved for it,
// which is what let two short-content, long-module-name boxes overlap.
function cgBoxLabelWidth(moduleName) {
  return moduleName.length * CG_CHAR_WIDTH + 16;
}

// A box's DRAWN rectangle (see boxRect in graph_hook.js) is its content
// plus this padding on every side (BOX_PAD_TOP is taller, to leave room
// for the module-name label at the top). Declared here, not in either of
// the two files that use it, because graph_layout.js's layoutModule must
// reserve exactly this much extra space during layout too: reserving only
// the raw content width and padding just the DRAWING left every box's
// actual rectangle several pixels wider than what layout had set aside
// for it, so adjacent boxes' drawn rectangles overlapped even though
// their underlying node positions never did.
var BOX_PAD_X = 10;
var BOX_PAD_TOP = 26;
var BOX_PAD_BOTTOM = 10;
var NODE_HALF_ROW = 28; // half a node's own rendered height (circle + multi-line label)

var CG_STATUS_COLOR = {
  added: "#3fb950",
  removed: "#f85149",
  modified: "#d29922",
};

var CG_CALLER_EDGE_COLOR = "#5a5a66"; // dim/halftone — the caller tree above the root is implicit context, not the primary call tree

// Click-to-focus colors: a clicked node's INCOMING edges/callers (purple)
// vs OUTGOING edges/callees (orange) — deliberately far from the status
// palette above (green/red/amber) and the multi-select blue, so all four
// meanings stay visually distinct at once.
var CG_INCOMING_EDGE_COLOR = "#a78bfa";
var CG_OUTGOING_EDGE_COLOR = "#ffa94d";
var CG_DIM_OPACITY = 0.1;

// Escape clears both node selection and any active browser text
// selection. Tracked at module scope (not just inside cgRenderGraph) so a
// re-render (filter change, diff reload, etc.) can remove the PREVIOUS
// render's listener before adding a new one — otherwise every re-render
// would leak another document-level listener, each holding a closure
// over that render's now-stale selectedIds/updateSelectionHighlight.
var cgEscListener = null;

// Whether each node's small module-name line is shown, toggled from the
// toolbar checkbox below. Tracked at module scope (not local to
// cgRenderGraph) so the choice survives a re-render (filter change, diff
// reload, etc.) instead of resetting to the default every time. Defaults
// to off — most of the time the node's color already ties it to a module
// well enough, and the extra line is clutter until you need it.
var cgShowModuleLabels = false;

// Whether nodes flagged `stdlib` (Erlang/OTP or Elixir's own modules —
// see Codegraph.Scope.stdlib_module?/1) are hidden, toggled from the
// toolbar checkbox below. Same module-scope persistence as
// cgShowModuleLabels above. Defaults to ON: this tool exists to surface
// architecture in the project's OWN code, and a call like `Enum.map/2`
// is rarely part of that — left on by default, every such call would
// otherwise add a same-named leaf node cluttering the graph.
var cgHideStdlib = true;
