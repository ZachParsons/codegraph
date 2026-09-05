window.CodegraphHooks = window.CodegraphHooks || {};

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
// rendering below) rather than prefixed onto the function name itself,
// which made that line too long.
function cgModuleShort(mod) {
  var parts = mod.split(".");
  return parts[parts.length - 1];
}

// Parameter names always come from the def head itself (no static types
// required for that). @spec input/output types are layered on top only
// when present — most functions won't have one, since @spec is optional
// idiomatic Elixir, not mandatory. Always shown on the graph now (not a
// hover tooltip), so this also drives each node's on-screen footprint —
// see nodeSize below, which sizes each node's slot from these same lines
// rather than a fixed guess.
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
// top-left — see cgRenderGraph) can be wider than every one of its
// member nodes' own cgLabelWidth (a deeply nested module name next to a
// short function name/arity, say). Shared by both the box-aware contour
// layout (which must reserve enough horizontal space to avoid a
// neighboring box) and the actual rectangle drawn later — using the same
// formula in both places is what keeps a box's drawn width from
// silently exceeding what was reserved for it, which is what let two
// short-content, long-module-name boxes overlap.
function cgBoxLabelWidth(moduleName) {
  return moduleName.length * CG_CHAR_WIDTH + 16;
}

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

function cgRenderGraph(container, data) {
  container.innerHTML = "";
  if (cgEscListener) {
    document.removeEventListener("keydown", cgEscListener);
    cgEscListener = null;
  }
  if (!data.nodes.length) {
    container.innerHTML =
      '<p style="opacity:0.6; padding: 1rem;">No nodes in scope.</p>';
    return;
  }

  var toolbar = document.createElement("div");
  toolbar.style.cssText =
    "padding: 0.5rem 1.5rem; display:flex; align-items:center; gap:0.5rem;";
  toolbar.innerHTML =
    '<input type="text" placeholder="filter by module or function…" ' +
    'style="background:#16161c; color:#eee; border:1px solid #333; border-radius:6px; ' +
    'padding:4px 8px; font-family:ui-monospace,monospace; font-size:12px; width:280px;">' +
    '<label style="display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.8; cursor:pointer;">' +
    '<input type="checkbox" id="cg-module-label-toggle">module names</label>' +
    '<span style="opacity:0.5; font-size:11px;">scroll/two-finger swipe to pan, pinch to zoom · click a node to highlight its callers/calls · drag a node, or a module\'s label to move all its nodes · shift+drag to select an area, shift or ctrl/cmd+click to select one at a time, esc to clear · click a label to collapse</span>';
  container.appendChild(toolbar);
  var searchInput = toolbar.querySelector("input");
  var moduleLabelToggle = toolbar.querySelector("#cg-module-label-toggle");
  moduleLabelToggle.checked = cgShowModuleLabels;

  var nodesById = {};
  data.nodes
    .filter(function (n) {
      return n.function;
    })
    .forEach(function (n) {
      nodesById[cgNodeId(n)] = n;
    });

  // Caller edges (kind "caller", added by Codegraph.Scope for each root's
  // own immediate callers) never enter d3-dag's graph: they're not part
  // of the downward call tree sugiyama lays out, and a node reachable
  // ONLY via a caller edge shouldn't be pre-registered there either — the
  // upfront registration pass below exists to catch nodes with zero
  // edges at all (e.g. a depth-0 root), and pre-registering a caller-only
  // node the same way would let it fall into visitForTree's "no incoming
  // edge -> treat as its own root" fallback, wasting horizontal space in
  // the top row reserved for a node that's about to be repositioned above
  // the tree anyway (see the caller-layout pass below). A node counts as
  // caller-only only if EVERY edge touching it is a caller edge — a node
  // that's legitimately both keeps its normal spot.
  var callerOnlyIds = new Set();
  data.edges.forEach(function (e) {
    if (e.kind === "caller") callerOnlyIds.add(cgNodeId(e.from));
  });
  data.edges.forEach(function (e) {
    if (e.kind === "caller") return;
    callerOnlyIds.delete(cgNodeId(e.from));
    callerOnlyIds.delete(cgNodeId(e.to));
  });

  var graph = d3.graph();
  var built = {};
  function ensureNode(n) {
    var id = cgNodeId(n);
    if (!nodesById[id]) nodesById[id] = n;
    if (!built[id]) built[id] = graph.node(id);
    return built[id];
  }
  data.nodes
    .filter(function (n) {
      return n.function && !callerOnlyIds.has(cgNodeId(n));
    })
    .forEach(ensureNode);

  var edgeList = []; // {fromId, toId, status, kind} — feeds sugiyama + the downward tidy tree
  var callerEdgeList = []; // kind "caller" — laid out separately, one level above the root(s)
  data.edges.forEach(function (e) {
    var fromId = cgNodeId(e.from);
    var toId = cgNodeId(e.to);
    if (!nodesById[fromId]) nodesById[fromId] = e.from;
    if (!nodesById[toId]) nodesById[toId] = e.to;

    if (e.kind === "caller") {
      callerEdgeList.push({ fromId: fromId, toId: toId, status: e.status, kind: e.kind });
      return;
    }

    var a = ensureNode(e.from);
    var b = ensureNode(e.to);
    edgeList.push({ fromId: fromId, toId: toId, status: e.status, kind: e.kind });
    // d3-dag's sugiyama layout requires a DAG; a self-call (recursion) would
    // be a self-loop, which isn't a valid DAG edge, so it's dropped here —
    // the node itself still renders, just without a self-referencing arrow.
    if (a === b) return;
    graph.link(a, b);
  });

  // nodeSize is [within-layer spacing, between-layer spacing]. Sugiyama
  // lays out with y = layer depth, x = spread within a layer — exactly a
  // traditional top-down tree: roots at low y, leaves at high y, callers
  // above callees. (An earlier version swapped x/y to fight a "too wide"
  // complaint on a shallow/wide graph — reverted, since that put depth on
  // the horizontal axis and roots off to one side instead of on top.)
  //
  // The second value (160) only feeds sugiyama's own internal layout math
  // (crossing minimization etc.) — it does NOT determine final on-screen
  // vertical spacing, which is recomputed just below from the actual
  // viewport height and level count instead of a fixed guess.
  //
  // The first value is now computed PER NODE from that node's own label
  // (function name + param names + types, always shown on the graph, not
  // hidden behind a hover) rather than one fixed width for every node —
  // sugiyama's nodeSize callback receives the node itself, so a node with
  // a long typed signature gets more room and a short one doesn't waste
  // space it doesn't need.
  var layout = d3.sugiyama().nodeSize(function (node) {
    var info = nodesById[node.data];
    return [Math.max(cgLabelWidth(info), 120), 160];
  });
  var extent = layout(graph);

  // Mutable render-space position store — the single source of truth used
  // by every draw call below, so dragging and overlap resolution can move
  // nodes freely without needing to touch the underlying d3-dag layout.
  //
  // Layer (depth) assignment normally comes from sugiyama: correctly
  // handling arbitrary DAG topology (nodes reachable via more than one
  // path, etc.) is genuinely hard to get right by hand, so that part is
  // kept as the fallback for the unscoped (no --root) whole-project view,
  // where there's no root to BFS from at all. Whenever a node DOES carry
  // a `level` (Codegraph.Scope.scope/4's own function-call-hop BFS — see
  // its moduledoc), that's used instead: it's exactly "how many calls
  // from the nearest root", giving one row per call including calls that
  // stay inside the same module — sugiyama's own layer can skip rows
  // along a single edge (a child isn't guaranteed to be exactly
  // parent-layer+1, only >), which `level` doesn't.
  //
  // Horizontal position within a layer does NOT come from sugiyama — its
  // own x is purely an edge-crossing-minimization heuristic with no
  // relationship to the source code (confirmed: neither call order nor
  // definition order). That's replaced below with a call-order pass
  // instead, since edgeList is already in call order end to end (see
  // Codegraph.Analyzer/Scope) — x starts at 0 here and gets a real value
  // once each node's layer is known.
  var pos = {};
  var nodeLayer = {};
  Array.from(graph.nodes()).forEach(function (n) {
    var info = nodesById[n.data];
    var layer = info && info.level != null ? info.level : n.y;
    pos[n.data] = { x: 0, y: layer };
    nodeLayer[n.data] = layer;
  });

  // A fixed per-level pixel gap either wastes the viewport (few levels)
  // or stays cramped (many levels) depending on the graph. Instead: find
  // how many distinct depth layers sugiyama actually produced, then
  // space them so the whole depth axis divides the viewport height
  // evenly — level count varies per graph, so this is computed after
  // layout rather than baked into nodeSize up front.
  var viewportHeight = Math.max(window.innerHeight - 140, 400);
  var layerYs = Array.from(
    new Set(
      Object.keys(nodeLayer).map(function (id) {
        return Math.round(nodeLayer[id] * 100) / 100;
      })
    )
  ).sort(function (a, b) {
    return a - b;
  });
  var layerIndexByY = {};
  layerYs.forEach(function (y, i) {
    layerIndexByY[y] = i;
  });
  Object.keys(nodeLayer).forEach(function (id) {
    nodeLayer[id] = layerIndexByY[Math.round(nodeLayer[id] * 100) / 100];
  });

  // `nodeLayer` itself (compacted, 0-based) is still used below, purely
  // as a tie-breaker for which caller legitimately claims a shared node
  // in the spanning tree (see visitForTree) and to seed that tree from
  // the real roots (layer 0) — but it no longer drives Y position
  // directly: every node's row now comes from where it lands inside its
  // module's box (a flat vertical list — see ROW_HEIGHT and layoutModule
  // further down), which is a fundamentally different vertical axis (box
  // nesting depth, not call-hop count) and is computed there instead.

  // Tidy-tree horizontal placement: nodes are grouped into "boxes" keyed
  // by MODULE — every node belonging to a module is a member of that
  // module's ONE box, wherever in the call tree it's reached from, so a
  // module never splits into several visual locations even when its own
  // functions are structurally unrelated (never call each other, or are
  // only reachable via completely different subtrees). Boxes, not
  // individual nodes, are the units a Reingold-Tilford-with-contour-merge
  // places left to right, each parent box centered over its own child
  // boxes with no overlap.
  //
  // A general DAG isn't a tree, though (a node can have more than one
  // caller) — so this first picks ONE spanning tree out of it via DFS
  // from the layer-0 roots, in call order (edgeList's order): a node
  // reached by more than one caller is positioned under whichever
  // caller's DFS found it first, and its OTHER callers still get their
  // edge drawn to wherever it ends up, without influencing that position
  // themselves. A widely-shared callee (a stdlib helper, say) stays a
  // single node with multiple incoming edges rather than being
  // duplicated per caller — this is exactly what makes that possible.
  var childrenOf = {};
  edgeList.forEach(function (e) {
    if (!pos[e.fromId] || !pos[e.toId] || e.fromId === e.toId) return;
    (childrenOf[e.fromId] = childrenOf[e.fromId] || []).push(e.toId);
  });

  var treeVisited = {};
  var treeChildrenOf = {};
  var treeRoots = [];
  function visitForTree(id, parent) {
    if (treeVisited[id]) return;
    treeVisited[id] = true;
    if (parent === undefined) {
      treeRoots.push(id);
    } else {
      (treeChildrenOf[parent] = treeChildrenOf[parent] || []).push(id);
    }
    (childrenOf[id] || []).forEach(function (childId) {
      // A node reachable via more than one caller must be claimed by a
      // caller whose OWN layer is consistent with it — otherwise this
      // DFS (which explores fully before backtracking to a sibling) can
      // claim it under a needlessly long real path before its true
      // shortest-path caller (elsewhere in the walk) ever gets the
      // chance, which would put it in a module's own vertical list (see
      // ROW_HEIGHT further down) via a far less natural route than the
      // graph actually calls it by. With a real `level` present (a
      // shortest-hop BFS count — see Codegraph.Scope.scope/4),
      // "consistent" means exactly one hop deeper; the unscoped
      // whole-project view has no such `level` and falls back to
      // sugiyama's own layer, which only guarantees a child's layer is
      // GREATER, not exactly +1 (see the layer-assignment note above).
      var childInfo = nodesById[childId];
      var consistent =
        childInfo && childInfo.level != null
          ? nodeLayer[childId] === nodeLayer[id] + 1
          : nodeLayer[childId] > nodeLayer[id];
      if (consistent) visitForTree(childId, id);
    });
  }
  Object.keys(nodeLayer)
    .filter(function (id) {
      return nodeLayer[id] === 0;
    })
    .forEach(function (id) {
      visitForTree(id, undefined);
    });
  Object.keys(nodeLayer).forEach(function (id) {
    visitForTree(id, undefined); // any node not reached from a layer-0 root becomes its own root
  });

  // Box assignment: a node's box IS its module — no walk needed, just
  // group by the field every node already carries. Membership is
  // recorded by walking the spanning tree instead of iterating nodeLayer
  // directly, purely to keep `boxMembers` in call order (matching
  // edgeList's own order — see the note above on why that matters for
  // layout).
  var boxOf = {};
  var boxMembers = {};
  treeRoots.forEach(function (rootId) {
    (function walk(id) {
      var mod = nodesById[id].module;
      boxOf[id] = mod;
      (boxMembers[mod] = boxMembers[mod] || []).push(id);
      (treeChildrenOf[id] || []).forEach(walk);
    })(rootId);
  });

  // The module-level spanning tree: exactly like the function-level one
  // above, but over MODULE identities instead of individual nodes —
  // needed so a module reached as a cross-module "exit" from more than
  // one place (very common: two unrelated functions in two different
  // modules both happen to call the same third module) still gets laid
  // out, and thus positioned, exactly once rather than being recursed
  // into from every place that reaches it.
  var moduleTreeVisited = {};
  var moduleChildrenOf = {};
  var moduleTreeRoots = [];
  function visitModule(mod, parentMod) {
    if (moduleTreeVisited[mod]) return;
    moduleTreeVisited[mod] = true;
    if (parentMod === undefined) {
      moduleTreeRoots.push(mod);
    } else {
      (moduleChildrenOf[parentMod] = moduleChildrenOf[parentMod] || []).push(mod);
    }
    boxMembers[mod].forEach(function (memberId) {
      (treeChildrenOf[memberId] || []).forEach(function (childId) {
        var childMod = boxOf[childId];
        if (childMod !== mod) visitModule(childMod, mod);
      });
    });
  }
  treeRoots
    .map(function (id) {
      return boxOf[id];
    })
    .forEach(function (mod) {
      visitModule(mod, undefined);
    });
  Object.keys(boxMembers).forEach(function (mod) {
    visitModule(mod, undefined); // any module not reached becomes its own root
  });

  // Real Reingold-Tilford, via contour merging — replaces an earlier
  // "reserve each subtree's total width" version that was verified
  // wasteful: it reserves enough width for a subtree's WIDEST descendant
  // layer and gives that same full width to every ancestor above it, so
  // a chain that's narrow everywhere except one deep fan-out ends up with
  // huge empty margins around every narrow node in that chain (confirmed
  // against real Broadway data — up to 4x a node's own label width, and
  // some layers had 2-3x more empty span than actual content).
  //
  // Contour merging fixes this by comparing, row by row, the RIGHT
  // silhouette of everything already placed against the LEFT silhouette
  // of the next module box, and shifting the new box only as far right
  // as the tightest shared row actually requires — not by its total
  // width. Two boxes that are both narrow at some deep row can interleave
  // closely there even if one of them is wide higher up.
  //
  // A module's own functions are laid out as a plain vertical LIST inside
  // its box — one row each, in call order, all in a single column — not
  // as a branching tree: every row is therefore the SAME width (the
  // widest member), reserved uniformly at every row the box spans, so a
  // neighboring box can never tuck into it. Rows are counted purely by
  // this box nesting (a box's own N members occupy N rows, then each
  // module-tree child — an "exit" — starts immediately below, however
  // many rows ITS OWN list plus its own exits need), not by call-hop
  // count — see ROW_HEIGHT below for why that's a different axis now.
  // Plain objects (not arrays) hold the per-row values so gaps don't
  // need explicit padding.
  var TREE_GAP = 24;

  // A caller-of-the-root box (see the caller-layout pass further down) is
  // keyed by this prefix + its module name, rather than the bare module
  // name a downward-tree box uses, so the two can never collide/merge —
  // declared up here (not down where it's first needed) so layoutModule
  // below, which every box's layout runs through, can share it too.
  var CG_CALLER_BOX_PREFIX = "caller:";

  // A box's DRAWN rectangle (see boxRect further down) is its content
  // plus this padding on every side (BOX_PAD_TOP is taller, to leave
  // room for the module-name label at the top). Defined here — not down
  // by boxRect itself — because layoutModule below must reserve exactly
  // this much extra space during layout too: reserving only the raw
  // content width and padding just the DRAWING left every box's actual
  // rectangle several pixels wider than what TREE_GAP had set aside for
  // it, so adjacent boxes' drawn rectangles overlapped even though their
  // underlying node positions never did.
  var BOX_PAD_X = 10;
  var BOX_PAD_TOP = 26;
  var BOX_PAD_BOTTOM = 10;
  var NODE_HALF_ROW = 28; // half a node's own rendered height (circle + multi-line label)

  // Vertical distance between consecutive rows within one module's own
  // list. A fixed constant, not the old viewport-filling calculation:
  // rows now count list position and box nesting, not a bounded "how
  // many BFS levels does the whole graph have", so there's no natural
  // total count to divide the viewport by any more — just always give a
  // member (up to a 3-line label: module name, signature, return type —
  // plus its circle, see NODE_HALF_ROW) enough room not to crowd its
  // neighbors.
  //
  // Must exceed a box's own padded span around a single row (2 *
  // NODE_HALF_ROW + BOX_PAD_TOP + BOX_PAD_BOTTOM = 92): the contour
  // system (below) only reserves horizontal separation between two boxes
  // at rows they actually SHARE, so two boxes that end up at adjacent —
  // not shared — absolute rows (whether one is the other's module-tree
  // child, or they're entirely unrelated subtrees that just happened to
  // land next to each other) are never compared at all. If a row's own
  // padded span were taller than the gap to the next row, their drawn
  // rectangles could still overlap despite occupying "different" rows.
  // The margin here (18px) is deliberately on top of that minimum, not
  // padding-tight, to keep drawn boxes/rows visually separated.
  var ROW_HEIGHT = 110;

  // Extra whole rows inserted between a box's own list and its
  // module-tree children (see layoutModule below) — purely a visual cue
  // (not load-bearing for overlap prevention now that ROW_HEIGHT itself
  // exceeds a row's own padded span) so a new box beginning reads as
  // more of a break than the next item in the same list.
  var MODULE_GAP_ROWS = 1;

  // Shared below (and by the root-level merge further down): places
  // `childLayouts` left to right, shifting each one just far enough
  // right that, at every ABSOLUTE row where it and everything already
  // placed both have a contour, they're at least TREE_GAP apart.
  function mergeChildrenLeftToRight(childLayouts) {
    var offsets = new Array(childLayouts.length);
    var combinedLeft = {};
    var combinedRight = {};
    childLayouts.forEach(function (cl, i) {
      var shift = 0;
      if (i > 0) {
        Object.keys(cl.leftContour).forEach(function (row) {
          if (!combinedRight.hasOwnProperty(row)) return;
          var needed = combinedRight[row] + TREE_GAP - cl.leftContour[row];
          if (needed > shift) shift = needed;
        });
      }
      offsets[i] = shift;
      Object.keys(cl.leftContour).forEach(function (row) {
        var lv = cl.leftContour[row] + shift;
        var rv = cl.rightContour[row] + shift;
        if (combinedLeft.hasOwnProperty(row)) {
          if (lv < combinedLeft[row]) combinedLeft[row] = lv;
          if (rv > combinedRight[row]) combinedRight[row] = rv;
        } else {
          combinedLeft[row] = lv;
          combinedRight[row] = rv;
        }
      });
    });
    return { offsets: offsets, combinedLeft: combinedLeft, combinedRight: combinedRight };
  }

  // A module's own layout: its members stacked as a plain vertical list
  // (relY 0, 1, 2, ... in call order, all at relX 0 — a single column),
  // then each module-tree child ("exit" — see moduleChildrenOf above)
  // recursively laid out and placed starting immediately below this
  // box's own rows, spread out left-to-right via the same contour merge
  // used everywhere else so two exits (or an exit and this box's own
  // rows) never overlap. Returned leftContour/rightContour are keyed by
  // row LOCAL to this module's own top (0 = this module's first member),
  // not by any absolute/global count — self-consistent by construction,
  // since every row number here comes from this same recursive walk, not
  // from an external reference the recursion could disagree with.
  function layoutModule(mod) {
    var members = boxMembers[mod];
    var ownHeight = members.length;

    // Floored at 120 to match boxRect's own per-node minimum further
    // down — reserving only the raw (unfloored) label width here left
    // short-labeled nodes (an external leaf like "each/2", say) with a
    // narrower reservation than the rectangle boxRect actually draws
    // for them, so two short-labeled sibling boxes could still overlap.
    var contentWidth = Math.max.apply(
      null,
      members.map(function (id) {
        return Math.max(cgLabelWidth(nodesById[id]), 120);
      })
    );
    // Reserve exactly what boxRect below will actually draw: content
    // padded by BOX_PAD_X on both sides, widened further on the right if
    // the module's own label (which can be wider than its content — see
    // cgBoxLabelWidth) needs more room than that. Reserving only the raw
    // content width here — leaving BOX_PAD_X to be added purely at draw
    // time — left every drawn rectangle wider than what TREE_GAP had
    // actually set aside for it, so adjacent boxes' rectangles
    // overlapped even where the underlying node positions didn't.
    // A caller box's own key carries the "caller:" prefix (see
    // CG_CALLER_BOX_PREFIX above) so it can't collide with a downward-tree
    // box for the same module — but the LABEL actually drawn (see
    // boxModule further down) is just the bare module name, so the width
    // reserved for it here has to strip the prefix too, or every caller
    // box would reserve several extra characters' worth of width it never
    // draws.
    var labelWidth = cgBoxLabelWidth(
      mod.indexOf(CG_CALLER_BOX_PREFIX) === 0 ? mod.slice(CG_CALLER_BOX_PREFIX.length) : mod
    );
    var halfContent = contentWidth / 2;
    var boxLeft = -halfContent - BOX_PAD_X;
    var boxRight = Math.max(halfContent + BOX_PAD_X, -halfContent + labelWidth);

    var relX = {};
    var relY = {};
    members.forEach(function (id, i) {
      relX[id] = 0;
      relY[id] = i;
    });

    var selfEntry = { leftContour: {}, rightContour: {} };
    for (var r = 0; r < ownHeight; r++) {
      selfEntry.leftContour[r] = boxLeft;
      selfEntry.rightContour[r] = boxRight;
    }

    var exitModules = moduleChildrenOf[mod] || [];
    if (!exitModules.length) {
      return {
        relX: relX,
        relY: relY,
        totalHeight: ownHeight,
        leftContour: selfEntry.leftContour,
        rightContour: selfEntry.rightContour,
      };
    }

    // Each exit's own contour (rows 0..itsHeight-1, local to ITS top) is
    // shifted down by ownHeight + MODULE_GAP_ROWS before merging, so
    // "exit's row 0" lines up with "MODULE_GAP_ROWS rows after this
    // box's own last member" — the same idea as the pseudo self-entry
    // trick used elsewhere, just shifting rows here instead of shifting
    // X.
    var childRowOffset = ownHeight + MODULE_GAP_ROWS;
    var exitLayouts = exitModules.map(function (childMod) {
      var el = layoutModule(childMod);
      var lc = {};
      var rc = {};
      Object.keys(el.leftContour).forEach(function (row) {
        lc[Number(row) + childRowOffset] = el.leftContour[row];
        rc[Number(row) + childRowOffset] = el.rightContour[row];
      });
      return { leftContour: lc, rightContour: rc, relX: el.relX, relY: el.relY, totalHeight: el.totalHeight };
    });

    var merged = mergeChildrenLeftToRight([selfEntry].concat(exitLayouts));

    exitLayouts.forEach(function (el, i) {
      var offset = merged.offsets[i + 1]; // +1: offsets[0] is the self entry
      Object.keys(el.relX).forEach(function (nid) {
        relX[nid] = el.relX[nid] + offset;
        relY[nid] = el.relY[nid] + childRowOffset;
      });
    });

    // Center this box over the exits' combined span (first to last),
    // same centering rule used everywhere else — this box's own rows
    // stay at relX 0 relative to that center, i.e. they shift too.
    var nodeX = (merged.offsets[1] + merged.offsets[merged.offsets.length - 1]) / 2;
    Object.keys(relX).forEach(function (nid) {
      relX[nid] -= nodeX;
    });

    var leftContour = {};
    var rightContour = {};
    Object.keys(merged.combinedLeft).forEach(function (row) {
      leftContour[row] = merged.combinedLeft[row] - nodeX;
      rightContour[row] = merged.combinedRight[row] - nodeX;
    });

    var maxExitHeight = Math.max.apply(
      null,
      exitLayouts.map(function (el) {
        return el.totalHeight;
      })
    );

    return {
      relX: relX,
      relY: relY,
      totalHeight: childRowOffset + maxExitHeight,
      leftContour: leftContour,
      rightContour: rightContour,
    };
  }

  // Same contour-merge logic applies one level up, to place the separate
  // root modules (Broadway's own box, say, alongside any other module
  // that's a root in its own right) against each other — an imaginary
  // shared parent isn't needed, just the same left-to-right contour
  // comparison used for sibling boxes above. Every root module starts at
  // row 0 (they're independent, side by side, not stacked on each other).
  var moduleRootLayouts = moduleTreeRoots.map(layoutModule);
  var moduleRootMerged = mergeChildrenLeftToRight(moduleRootLayouts);

  moduleTreeRoots.forEach(function (mod, i) {
    var rl = moduleRootLayouts[i];
    var offset = moduleRootMerged.offsets[i];
    Object.keys(rl.relX).forEach(function (nid) {
      pos[nid].x = rl.relX[nid] + offset;
      pos[nid].y = (rl.relY[nid] + 0.5) * ROW_HEIGHT;
    });
  });

  // Callers of the root(s) — exactly one generation, never fed through
  // sugiyama or the downward contour merge above (see callerOnlyIds) —
  // are grouped into one box per MODULE (e.g. two different Broadway
  // wrapper functions both calling into Broadway.Topology share one
  // dashed box, not two), same as the downward tree gets. Each such box
  // reuses layoutModule for its own flat vertical list (a caller box
  // never has module-tree "exits" of its own — see moduleChildrenOf, only
  // ever populated from the downward tree — so that call always takes
  // its simple, no-recursion path) and the same mergeChildrenLeftToRight
  // used for every other sibling-box placement, so two caller boxes can
  // never overlap each other.
  //
  // The whole caller layer is then placed as its own row a full
  // (1 + MODULE_GAP_ROWS) * ROW_HEIGHT above `treeMinY` — the topmost
  // point of the ENTIRE downward tree computed just below, not merely
  // whichever root a given caller happens to call — so a caller box can
  // never overlap a downward-tree box either, regardless of which
  // (possibly deeply-nested) function within that tree it calls. A
  // caller shared by more than one root is placed once, under whichever
  // root claims it first.
  var treeIds = Object.keys(pos);
  var treeMinX = Math.min.apply(
    null,
    treeIds.map(function (id) {
      return pos[id].x;
    })
  );
  var treeMaxX = Math.max.apply(
    null,
    treeIds.map(function (id) {
      return pos[id].x;
    })
  );
  var treeMinY = Math.min.apply(
    null,
    treeIds.map(function (id) {
      return pos[id].y;
    })
  );

  var callerModuleMembers = {};
  var callerClaimedBy = {};
  callerEdgeList.forEach(function (e) {
    if (!pos[e.toId] || callerClaimedBy[e.fromId] !== undefined) return;
    callerClaimedBy[e.fromId] = e.toId;
    var mod = nodesById[e.fromId].module;
    (callerModuleMembers[mod] = callerModuleMembers[mod] || []).push(e.fromId);
  });

  var callerBoxKeys = Object.keys(callerModuleMembers).map(function (mod) {
    var key = CG_CALLER_BOX_PREFIX + mod;
    // Reversed so the first-called caller lands nearest the top of its
    // box — layoutModule always gives its LAST member the row closest to
    // `treeMinY` (see the y formula below), which for this upward-
    // growing layer is the row nearest the tree, mirroring the downward
    // tree's own call-order-top-to-bottom convention.
    boxMembers[key] = callerModuleMembers[mod].slice().reverse();
    boxMembers[key].forEach(function (id) {
      boxOf[id] = key;
    });
    return key;
  });

  if (callerBoxKeys.length) {
    var callerLayouts = callerBoxKeys.map(layoutModule);
    var callerMerged = mergeChildrenLeftToRight(callerLayouts);

    var callerLeftVals = Object.keys(callerMerged.combinedLeft).map(function (row) {
      return callerMerged.combinedLeft[row];
    });
    var callerRightVals = Object.keys(callerMerged.combinedRight).map(function (row) {
      return callerMerged.combinedRight[row];
    });
    var callerLayerCenterX =
      (Math.min.apply(null, callerLeftVals) + Math.max.apply(null, callerRightVals)) / 2;
    var xShift = (treeMinX + treeMaxX) / 2 - callerLayerCenterX;
    var callerLayerBaseY = treeMinY - (1 + MODULE_GAP_ROWS) * ROW_HEIGHT;

    callerBoxKeys.forEach(function (key, i) {
      var cl = callerLayouts[i];
      var offset = callerMerged.offsets[i] + xShift;
      Object.keys(cl.relX).forEach(function (id) {
        pos[id] = {
          x: cl.relX[id] + offset,
          y: callerLayerBaseY - cl.relY[id] * ROW_HEIGHT,
        };
      });
    });
  }

  // Every box's members already came from `pos` by construction (module
  // boxes via the spanning tree, caller boxes via the module-grouping
  // above) — this sweep is purely a defensive fallback in case some other
  // id ever reaches `pos` without a box, not a path anything currently
  // takes. Its own singleton (id-keyed) boxes are why the next line reads
  // `boxIds = Object.keys(boxMembers)` rather than filtering anything.
  Object.keys(pos).forEach(function (id) {
    if (!boxOf[id]) {
      boxOf[id] = id;
      boxMembers[id] = [id];
    }
  });

  var boxIds = Object.keys(boxMembers);
  // A module-keyed box's id literally IS its module name; a caller box's
  // id carries the prefix stripped off above instead, so its module name
  // is recovered from that rather than from nodesById (a caller box can
  // have more than one member, so there's no single node id to look it
  // up from).
  var boxModule = {};
  boxIds.forEach(function (id) {
    boxModule[id] = id.indexOf(CG_CALLER_BOX_PREFIX) === 0 ? id.slice(CG_CALLER_BOX_PREFIX.length) : id;
  });

  // A BOX id's "is this caller context" check — distinct from
  // callerOnlyIds, which is a set of individual NODE ids and answers the
  // same question for a single node, not a (possibly multi-member) box.
  function isCallerBox(boxId) {
    return boxId.indexOf(CG_CALLER_BOX_PREFIX) === 0;
  }
  var moduleNames = Array.from(
    new Set(
      boxIds.map(function (id) {
        return boxModule[id];
      })
    )
  );
  var color = d3.scaleOrdinal(d3.schemeTableau10).domain(moduleNames);

  function translateBox(boxId, dx, dy) {
    boxMembers[boxId].forEach(function (id) {
      pos[id].x += dx;
      pos[id].y += dy;
    });
  }

  // A box is drawn as an actual rectangle around its own members (unlike
  // the single global floating label this replaced) — that's only
  // possible now because box assignment (above) puts a module's every
  // occurrence into ONE box, and the box-aware contour layout already
  // reserves enough space (including this same padding — see BOX_PAD_X
  // et al above) that nothing else lands inside it. Estimated (not DOM-
  // measured) label width, so this can run before any SVG text exists —
  // used both for the initial viewport sizing (contentExtent below) and
  // every redraw.
  function boxRect(boxId) {
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    boxMembers[boxId].forEach(function (id) {
      var p = pos[id];
      var half = Math.max(cgLabelWidth(nodesById[id]), 120) / 2;
      if (p.x - half < minX) minX = p.x - half;
      if (p.x + half > maxX) maxX = p.x + half;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    var labelWidth = cgBoxLabelWidth(boxModule[boxId]);
    var width = Math.max(maxX - minX + BOX_PAD_X * 2, labelWidth + BOX_PAD_X);
    return {
      x: minX - BOX_PAD_X,
      y: minY - NODE_HALF_ROW - BOX_PAD_TOP,
      width: width,
      height: maxY - minY + NODE_HALF_ROW * 2 + BOX_PAD_TOP + BOX_PAD_BOTTOM,
    };
  }

  function contentExtent() {
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    boxIds.forEach(function (id) {
      var r = boxRect(id);
      if (r.x < minX) minX = r.x;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y < minY) minY = r.y;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
    });
    return { minX: minX - 20, maxX: maxX + 20, minY: minY - 20, maxY: maxY + 20 };
  }

  var content = contentExtent();
  var width = Math.max(content.maxX - content.minX + 220, 640);
  var height = Math.max(content.maxY - content.minY + 140, 400);

  var svgWrap = d3
    .select(container)
    .append("div")
    .style("width", "100%")
    .style("height", viewportHeight + "px")
    .style("overflow", "hidden")
    .style("background", "#0b0b0f")
    .style("cursor", "grab");

  var svg = svgWrap
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .style("display", "block");

  var zoomLayer = svg.append("g");
  // Center horizontally (root-at-top-center), anchor near the top vertically.
  var xOffset = (width - (content.maxX - content.minX)) / 2 - content.minX;
  var root = zoomLayer
    .append("g")
    .attr("transform", "translate(" + xOffset + "," + (70 - content.minY) + ")");

  // Fit to HEIGHT only, not min(widthRatio, heightRatio). A wide graph's
  // widthRatio is routinely much smaller than its heightRatio, and since
  // zoom's scale is uniform (one factor for both axes, not independent
  // per-axis), fitting to width would scale height down by the same
  // factor — silently undoing the level-spacing fill above. Width instead
  // overflows and is reached by panning (drag), which already works.
  var fitScale = Math.min((viewportHeight - 40) / (height + 70), 1);

  // Tracked so node/module dragging (below) can convert screen-pixel drag
  // deltas into data-space units — 1 screen pixel of mouse movement is
  // 1/currentZoomK data units once zoomed in or out, not 1:1.
  var currentZoomK = 1;

  var zoom = d3.zoom().on("zoom", function (event) {
    zoomLayer.attr("transform", event.transform);
    currentZoomK = event.transform.k;
  });
  svg.call(zoom);
  svg.call(
    zoom.transform,
    d3.zoomIdentity.translate(20, 20).scale(Math.max(fitScale, 0.03))
  );

  var defs = svg.append("defs");
  // Three arrowheads (default/outgoing/incoming), swapped per edge in
  // updateFocusHighlight below — an SVG <marker> doesn't inherit its
  // path's stroke color on its own, so matching the arrowhead to a
  // focus-highlighted edge needs its own marker per color rather than one
  // shared marker.
  [
    { id: "cg-arrow", color: "#8a8a92" },
    { id: "cg-arrow-out", color: CG_OUTGOING_EDGE_COLOR },
    { id: "cg-arrow-in", color: CG_INCOMING_EDGE_COLOR },
  ].forEach(function (m) {
    defs
      .append("marker")
      .attr("id", m.id)
      .attr("viewBox", "0 -5 10 10")
      .attr("refX", 10)
      .attr("refY", 0)
      .attr("markerWidth", 6)
      .attr("markerHeight", 6)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,-5L10,0L0,5")
      .attr("fill", m.color);
  });

  var clusterLayer = root.append("g");
  var edgeLayer = root.append("g");
  var nodeLayer = root.append("g");

  // Additive/subtractive multi-select for whole module boxes, same idea
  // as nodes' selectedIds (see below) — shift/ctrl/cmd+click toggles a
  // box in or out of selectedBoxIds, and dragging any box that's part of
  // a multi-box selection moves every selected box together (see boxDrag
  // below). A separate set from nodes' selectedIds since the two
  // selections are independent: nodes and boxes are dragged by different
  // handles and moved by different code (pos[id] vs translateBox(boxId)).
  // Declared here, ahead of the rect creation just below, since
  // boxStroke()/boxStrokeWidth() are used as that rect's own initial
  // stroke/stroke-width accessors as well as by
  // updateBoxSelectionHighlight() later — both need selectedBoxIds to
  // already exist the moment they first run.
  var selectedBoxIds = new Set();

  function boxStroke(id) {
    return selectedBoxIds.has(id) ? "#4f9dff" : color(boxModule[id]);
  }

  function boxStrokeWidth(id) {
    return selectedBoxIds.has(id) ? 3 : 1.2;
  }

  function updateBoxSelectionHighlight() {
    clusters.select("rect").attr("stroke", boxStroke).attr("stroke-width", boxStrokeWidth);
  }

  // One rectangle per box — one per module in the downward tree (see box
  // assignment above), plus one per caller (kept separate — see
  // boxModule above). A caller box (see callerOnlyIds) is dimmed and
  // dashed to read as implicit/background context, matching the ordinary
  // downward tree's full-contrast boxes.
  var clusters = clusterLayer
    .selectAll("g")
    .data(boxIds)
    .join("g")
    .style("opacity", function (id) {
      return isCallerBox(id) ? 0.5 : 1;
    });

  clusters
    .append("rect")
    .attr("rx", 8)
    .attr("fill", "#16161c")
    .attr("fill-opacity", 0.5)
    .attr("stroke", boxStroke)
    .attr("stroke-width", boxStrokeWidth)
    .attr("stroke-dasharray", function (id) {
      return isCallerBox(id) ? "3,3" : null;
    })
    .style("cursor", "grab");

  clusters
    .append("text")
    .attr("x", 8)
    .attr("y", 15)
    .attr("fill", function (id) {
      return color(boxModule[id]);
    })
    .attr("font-size", 11)
    .attr("font-family", "ui-monospace, monospace")
    .style("cursor", "text")
    .text(function (id) {
      return boxModule[id];
    })
    .on("click", function (event, id) {
      collapsed[id] = !collapsed[id];
      applyFilters();
    });

  var collapsed = {};

  // Plain straight lines, not d3.linkVertical()'s curves — tried the
  // curved version first, but it didn't earn its complexity over just
  // drawing directly from node to node. d3-dag's own precomputed multi-
  // point paths aren't usable regardless, straight or curved: dragging
  // and the tidy-tree layout above move nodes independently of the
  // original static sugiyama positions, so edges are recomputed live
  // from current positions on every redraw.
  // Stops short of both nodes' own centers, at each one's rendered
  // boundary (plus a hair for its stroke) — otherwise the line ran all
  // the way center-to-center, leaving it visible past the arrow tip and
  // into the target node, and back through the source node's own origin
  // out the other side, on any dimmed/translucent node (opacity < 1
  // shows the line underneath straight through the fill).
  function edgePathD(fromId, toId) {
    var a = pos[fromId],
      b = pos[toId];
    if (!a || !b) return "";
    var dx = b.x - a.x,
      dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist,
      uy = dy / dist;
    var ra = cgNodeBoundaryDist(fromId, ux, uy) + 1;
    var rb = cgNodeBoundaryDist(toId, ux, uy) + 1;
    var sx = a.x + ux * ra,
      sy = a.y + uy * ra;
    var tx = b.x - ux * rb,
      ty = b.y - uy * rb;
    return "M" + sx + "," + sy + "L" + tx + "," + ty;
  }

  var edgePaths = edgeLayer
    .selectAll("path")
    .data(edgeList.concat(callerEdgeList))
    .join("path")
    .attr("fill", "none")
    .attr("stroke", function (e) {
      if (e.kind === "caller") return CG_CALLER_EDGE_COLOR;
      return CG_STATUS_COLOR[e.status] || "#8a8a92";
    })
    .attr("stroke-width", function (e) {
      return e.status in CG_STATUS_COLOR ? 2 : 1.4;
    })
    .attr("stroke-dasharray", function (e) {
      return e.status === "removed" ? "4,3" : null;
    })
    .attr("opacity", function (e) {
      return e.kind === "caller" ? 0.6 : 1;
    })
    .attr("marker-end", "url(#cg-arrow)");

  var nodeIds = Object.keys(pos);

  // A node's marker shape is the ONLY thing that encodes def (circle) vs
  // defp (diamond) — deliberately not color/opacity/stroke, since those
  // channels already carry status, external-ness, and selection/focus,
  // and a module's own box position can't be trusted for this once nodes
  // are free to be dragged independently of it (see the click-to-focus
  // comment below for the same reasoning applied to selection state).
  // Both shapes are drawn via one <path> per node (d3.symbol), not a
  // <circle> element, so every place below that reads/writes "the node's
  // marker" uses a single selector regardless of which shape it is.
  //
  // Diamond size is bumped relative to circle: a diamond drawn at the
  // same nominal area (d3.symbol's `size`) as a circle looks visibly
  // smaller to the eye (its mass sits closer to the center), so this
  // scales it up to read as roughly the same size on screen.
  var CG_DIAMOND_SIZE_MULT = 1.6;

  function cgNodeSymbolSize(id) {
    var base = CG_STATUS_COLOR[nodesById[id].status] ? 201 : 154; // matches the old r=8/r=7 circle areas
    return nodesById[id].visibility === "private" ? base * CG_DIAMOND_SIZE_MULT : base;
  }

  // A true rotated square (equal half-width/half-height), NOT d3's own
  // symbolDiamond — that built-in shape is a taller rhombus (~1.73x
  // height:width), which visibly obscured/overlapped the incoming call
  // edge: the edge-trimming below assumed a roughly circular boundary,
  // so on the built-in shape's much taller points the trimmed edge (and
  // its arrowhead) landed well inside the visible diamond instead of at
  // its tip.
  var cgSymbolSquareDiamond = {
    draw: function (context, size) {
      var r = Math.sqrt(size / 2);
      context.moveTo(0, -r);
      context.lineTo(r, 0);
      context.lineTo(0, r);
      context.lineTo(-r, 0);
      context.closePath();
    },
  };

  // Exact distance from a node's center to its own rendered boundary
  // along a given unit direction (ux, uy) — used to trim edges to the
  // boundary instead of the center (see edgePathD above). A circle's
  // boundary is the same distance in every direction; the diamond is a
  // true rotated square (see cgSymbolSquareDiamond just above), whose
  // |x| + |y| = r boundary sits at r / (|ux| + |uy|) along a unit
  // direction — the standard L1-ball distance formula. edgePathD passes
  // the same (ux, uy) for both the source and target node, which is only
  // valid because both shapes are centrally symmetric: the boundary
  // distance along a line is identical measured from either end.
  function cgNodeBoundaryDist(id, ux, uy) {
    var size = cgNodeSymbolSize(id);
    if (nodesById[id].visibility === "private") {
      var r = Math.sqrt(size / 2);
      return r / (Math.abs(ux) + Math.abs(uy) || 1);
    }
    return Math.sqrt(size / Math.PI);
  }

  function cgNodeSymbolPath(id) {
    var type = nodesById[id].visibility === "private" ? cgSymbolSquareDiamond : d3.symbolCircle;
    return d3.symbol().type(type).size(cgNodeSymbolSize(id))();
  }

  // Rubber-band multi-select state. Selected nodes get a highlighted
  // stroke — nodeStroke()/nodeStrokeWidth() are shared by the initial
  // marker creation below and by updateSelectionHighlight(), so both stay
  // in sync instead of duplicating the same status/external logic twice.
  var selectedIds = new Set();

  // Click-to-focus state: the one node last plain-clicked (no modifier),
  // plus the node ids reachable from it by one outgoing/incoming edge —
  // recomputed by updateFocusHighlight() below whenever focusedId changes.
  // A plain click is a distinct gesture from the modifier-based
  // multi-select above (selectedIds/rubber-band), so the two coexist
  // rather than sharing state.
  var focusedId = null;
  var connectedOutIds = new Set();
  var connectedInIds = new Set();

  function nodeStroke(id) {
    if (id === focusedId) return "#4f9dff";
    if (connectedOutIds.has(id)) return CG_OUTGOING_EDGE_COLOR;
    if (connectedInIds.has(id)) return CG_INCOMING_EDGE_COLOR;
    if (selectedIds.has(id)) return "#4f9dff";
    var info = nodesById[id];
    if (info.external || callerOnlyIds.has(id)) return "#777";
    return CG_STATUS_COLOR[info.status] || "#fff";
  }

  function nodeStrokeWidth(id) {
    if (id === focusedId || connectedOutIds.has(id) || connectedInIds.has(id)) return 3;
    if (selectedIds.has(id)) return 3;
    return CG_STATUS_COLOR[nodesById[id].status] ? 2 : 1.3;
  }

  // A node not connected to the focused one (when a focus is active) is
  // dimmed instead of hidden — hiding would also have to hide/re-layout
  // its edges and box, whereas dimming keeps the whole graph's shape
  // legible while still making the highlighted subgraph pop.
  function nodeOpacity(id) {
    var base = nodesById[id].external || callerOnlyIds.has(id) ? 0.55 : 1;
    if (!focusedId) return base;
    return id === focusedId || connectedOutIds.has(id) || connectedInIds.has(id) ? base : CG_DIM_OPACITY;
  }

  function updateSelectionHighlight() {
    nodeG.select(".cg-node-marker").attr("stroke", nodeStroke).attr("stroke-width", nodeStrokeWidth);
  }

  function edgeMarker(e) {
    if (outgoingEdgeSet.has(e)) return "url(#cg-arrow-out)";
    if (incomingEdgeSet.has(e)) return "url(#cg-arrow-in)";
    return "url(#cg-arrow)";
  }

  // Edge objects (not just node ids) reachable from the focused node —
  // membership is by object identity, which works because edgePaths' own
  // data (edgeList.concat(callerEdgeList)) is these exact same objects.
  var outgoingEdgeSet = new Set();
  var incomingEdgeSet = new Set();

  function updateFocusHighlight() {
    outgoingEdgeSet = new Set();
    incomingEdgeSet = new Set();
    connectedOutIds = new Set();
    connectedInIds = new Set();

    if (focusedId) {
      edgeList.concat(callerEdgeList).forEach(function (e) {
        if (e.fromId === focusedId) {
          outgoingEdgeSet.add(e);
          connectedOutIds.add(e.toId);
        }
        if (e.toId === focusedId) {
          incomingEdgeSet.add(e);
          connectedInIds.add(e.fromId);
        }
      });
    }

    edgePaths
      .attr("stroke", function (e) {
        if (outgoingEdgeSet.has(e)) return CG_OUTGOING_EDGE_COLOR;
        if (incomingEdgeSet.has(e)) return CG_INCOMING_EDGE_COLOR;
        if (e.kind === "caller") return CG_CALLER_EDGE_COLOR;
        return CG_STATUS_COLOR[e.status] || "#8a8a92";
      })
      .attr("stroke-width", function (e) {
        if (outgoingEdgeSet.has(e) || incomingEdgeSet.has(e)) return 2.5;
        return e.status in CG_STATUS_COLOR ? 2 : 1.4;
      })
      .attr("opacity", function (e) {
        if (!focusedId) return e.kind === "caller" ? 0.6 : 1;
        return outgoingEdgeSet.has(e) || incomingEdgeSet.has(e) ? 1 : CG_DIM_OPACITY;
      })
      .attr("marker-end", edgeMarker);

    nodeG.select(".cg-node-marker").attr("stroke", nodeStroke).attr("stroke-width", nodeStrokeWidth).attr("opacity", nodeOpacity);
    nodeG.select("text").attr("opacity", nodeOpacity);
  }

  // Escape clears node selection and any active text selection (from
  // click-dragging over a label — see the cursor/text-selection work
  // earlier). Fires regardless of focus, since this has no dedicated
  // input to blur out of other than the filter box, which handles its
  // own Escape natively (clearing focus, not text) without conflict.
  cgEscListener = function (event) {
    if (event.key !== "Escape") return;
    if (selectedIds.size) {
      selectedIds.clear();
      updateSelectionHighlight();
    }
    if (selectedBoxIds.size) {
      selectedBoxIds.clear();
      updateBoxSelectionHighlight();
    }
    if (focusedId) {
      focusedId = null;
      updateFocusHighlight();
    }
    var sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
  };
  document.addEventListener("keydown", cgEscListener);

  var nodeG = nodeLayer
    .selectAll("g")
    .data(nodeIds)
    .join("g")
    .attr("data-module", function (id) {
      return nodesById[id].module;
    });

  nodeG
    .append("path")
    .attr("class", "cg-node-marker")
    .attr("d", cgNodeSymbolPath)
    .attr("fill", function (id) {
      var info = nodesById[id];
      if (info.external || callerOnlyIds.has(id)) return "#3a3a3f";
      return CG_STATUS_COLOR[info.status] || color(info.module);
    })
    .attr("stroke", nodeStroke)
    .attr("stroke-width", nodeStrokeWidth)
    .attr("stroke-dasharray", function (id) {
      return nodesById[id].status === "removed" ? "3,2" : null;
    })
    .attr("opacity", nodeOpacity)
    .style("cursor", "grab");

  // Multi-line label via tspans (a plain .text() can't hold a line
  // break): a small module-name line first — its own tspan with its own
  // smaller size and module color, so it doesn't lengthen the signature
  // line itself — then the signature, then a return-type line when a
  // @spec provides one. All shown directly on the graph, not behind a
  // hover.
  nodeG
    .append("text")
    .attr("font-family", "ui-monospace, monospace")
    .attr("font-size", 11)
    .attr("fill", function (id) {
      var info = nodesById[id];
      if (info.external || callerOnlyIds.has(id)) return "#8a8a92";
      return CG_STATUS_COLOR[info.status] || "#eee";
    })
    .attr("opacity", nodeOpacity)
    .style("cursor", "text")
    .each(function (id) {
      var info = nodesById[id];
      var text = d3.select(this);

      text
        .append("tspan")
        .attr("class", "cg-module-label")
        .attr("x", 11)
        .attr("dy", -3)
        .attr("font-size", 9)
        .attr("fill", info.external || callerOnlyIds.has(id) ? "#666" : color(info.module))
        .style("display", cgShowModuleLabels ? null : "none")
        .text(cgModuleShort(info.module));

      cgLabelLines(info).forEach(function (line, i) {
        text
          .append("tspan")
          .attr("x", 11)
          .attr("dy", i === 0 ? 13 : 12)
          .text(line);
      });
    });

  nodeG.append("title").text(function (id) {
    return id;
  });

  function redraw() {
    nodeG.attr("transform", function (id) {
      var p = pos[id];
      return "translate(" + p.x + "," + p.y + ")";
    });

    edgePaths.attr("d", function (e) {
      return edgePathD(e.fromId, e.toId);
    });

    clusters.each(function (id) {
      var r = boxRect(id);
      var g = d3.select(this);
      g.attr("transform", "translate(" + r.x + "," + r.y + ")");
      g.select("rect").attr("width", r.width).attr("height", r.height);
    });
  }
  redraw();

  // Drag handles are the marker/rect only, never the text — a drag
  // behavior on an element swallows the mousedown+move gesture that
  // native browser text selection also needs, so attaching it to the
  // whole node/badge group (text included) made every label unselectable.
  // .raise() targets the parent <g> (not just the marker/rect it's
  // called on) so the whole node — text included — still comes to front
  // while being dragged.
  //
  // .container() is pinned to the never-moving outer <svg>, not left at
  // d3-drag's default (the dragged element's own parent). That default
  // was the actual cause of the reported "growing lag between cursor and
  // node": d3-drag measures each frame's pointer position relative to the
  // container, and the badge/node's own parent <g> is exactly the element
  // being translated as a RESULT of the drag (see redraw() below) — so
  // the reference frame itself shifts by however much we just moved the
  // node, under-counting the next frame's real mouse movement by that
  // same amount, compounding every frame. A fixed container has no such
  // feedback loop. Deltas from a fixed outer container come back in
  // screen pixels, not data-space units, so they're divided by the
  // current zoom scale (currentZoomK) before being applied to `pos` —
  // 1 screen pixel is 1/currentZoomK data units once zoomed in or out.
  // Rubber-band select state/helpers, shared by every drag behavior below
  // (boxDrag, nodeDrag, selectDrag) — shift held at drag-start means
  // "select an area", full stop, no matter which element the gesture
  // started on. Previously only a drag starting on truly empty canvas
  // reached this (via selectDrag, attached to the svg itself); a shift+
  // drag starting on a module box's rect or a node's marker was instead
  // captured by that element's own boxDrag/nodeDrag listener — neither of
  // which checked for shiftKey — so it moved the box/node instead of
  // selecting. Each of those now checks shiftKey at "start" and, when
  // held, delegates every step of the gesture to these three functions
  // instead of its normal move behavior.
  var selectionStart = null;
  var selectionRectEl = null;

  function rbStart(event) {
    selectionStart = d3.pointer(event, root.node());
    selectionRectEl = root
      .append("rect")
      .attr("x", selectionStart[0])
      .attr("y", selectionStart[1])
      .attr("width", 0)
      .attr("height", 0)
      .attr("fill", "#4f9dff")
      .attr("fill-opacity", 0.12)
      .attr("stroke", "#4f9dff")
      .attr("stroke-width", 1)
      .attr("pointer-events", "none");
  }

  function rbDrag(event) {
    var p = d3.pointer(event, root.node());
    var x = Math.min(selectionStart[0], p[0]);
    var y = Math.min(selectionStart[1], p[1]);
    selectionRectEl
      .attr("x", x)
      .attr("y", y)
      .attr("width", Math.abs(p[0] - selectionStart[0]))
      .attr("height", Math.abs(p[1] - selectionStart[1]));
  }

  function rbEnd(event) {
    var p = d3.pointer(event, root.node());
    var x0 = Math.min(selectionStart[0], p[0]),
      x1 = Math.max(selectionStart[0], p[0]);
    var y0 = Math.min(selectionStart[1], p[1]),
      y1 = Math.max(selectionStart[1], p[1]);

    selectedIds.clear();
    nodeIds.forEach(function (id) {
      var np = pos[id];
      if (np.x >= x0 && np.x <= x1 && np.y >= y0 && np.y <= y1) selectedIds.add(id);
    });

    selectionRectEl.remove();
    selectionRectEl = null;
    updateSelectionHighlight();
  }

  var boxDrag = d3
    .drag()
    .container(function () {
      return svg.node();
    })
    // d3.drag's default filter rejects ctrl-held gestures outright
    // (`!event.ctrlKey && !event.button`) — see the identical note on
    // nodeDrag below for why that matters: without overriding it,
    // ctrl+click-to-toggle a box's selection would never even reach
    // "start"/"end" here.
    .filter(function (event) {
      return !event.button;
    })
    .clickDistance(6)
    .on("start", function (event, id) {
      this._cgDragged = false;
      // Shift always means "select an area" (see the rubber-band block
      // above) — even a shift+click with no movement just tears back
      // down the (harmlessly empty) rect it starts here, in "end" below.
      if (event.sourceEvent && event.sourceEvent.shiftKey) {
        this._cgRubberBand = true;
        rbStart(event);
        return;
      }
      this._cgRubberBand = false;
      d3.select(this.parentNode).raise();
      var modifierHeld = event.sourceEvent && (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey);
      if (!modifierHeld && !selectedBoxIds.has(id)) {
        selectedBoxIds.clear();
        updateBoxSelectionHighlight();
      }
    })
    .on("drag", function (event, id) {
      this._cgDragged = true;
      if (this._cgRubberBand) {
        rbDrag(event);
        return;
      }
      var dx = event.dx / currentZoomK;
      var dy = event.dy / currentZoomK;
      if (selectedBoxIds.has(id) && selectedBoxIds.size > 1) {
        selectedBoxIds.forEach(function (bid) {
          translateBox(bid, dx, dy);
        });
      } else {
        translateBox(id, dx, dy);
      }
      redraw();
    })
    .on("end", function (event, id) {
      var wasRubberBand = this._cgRubberBand;
      this._cgRubberBand = false;
      if (wasRubberBand && this._cgDragged) {
        rbEnd(event);
        return;
      }
      if (wasRubberBand && selectionRectEl) {
        // Shift+click, no movement: drop the zero-size rect started in
        // "start" and fall through to the toggle logic below.
        selectionRectEl.remove();
        selectionRectEl = null;
      }
      if (this._cgDragged) return;
      var modifierHeld =
        event.sourceEvent &&
        (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey || event.sourceEvent.shiftKey);
      if (modifierHeld) {
        if (selectedBoxIds.has(id)) {
          selectedBoxIds.delete(id);
        } else {
          selectedBoxIds.add(id);
        }
        updateBoxSelectionHighlight();
      }
    });

  // Individual nodes are draggable too, independent of their box (which
  // still drags every member of that box together).
  //
  // Dragging a node that's part of the current selection (built via
  // shift+drag-an-area, or shift/ctrl/cmd+click — see "end" below) moves
  // every selected node together; dragging any other node clears the
  // selection first and moves just that one, same as before selection
  // existed at all. A modifier-held drag start skips that auto-clear,
  // since holding one means the user is trying to grow/shrink the
  // selection, not replace it.
  //
  // Click-to-toggle is handled here in "end" (checking whether any real
  // movement happened, via the `_cgDragged` flag set in "drag") instead
  // of a separate native "click" listener, which had a real bug: d3.drag's
  // DEFAULT filter is `!event.ctrlKey && !event.button` (confirmed in the
  // vendored bundle) — it rejects ctrl-held gestures outright, so
  // "start"/"drag"/"end" never fire for those, while a shift-held gesture
  // IS accepted and DOES fire them. That inconsistency is why ctrl+click
  // toggling worked (nodeDrag stayed out of the way entirely, so the
  // browser's native click fired untouched) while shift+click's highlight
  // never appeared (nodeDrag took over the gesture but nothing was
  // listening for its outcome). The filter below explicitly keeps ctrl
  // allowed too, so both modifiers now drive the exact same "end" path
  // instead of two different, inconsistently-working mechanisms.
  var nodeDrag = d3
    .drag()
    .container(function () {
      return svg.node();
    })
    .filter(function (event) {
      return !event.button;
    })
    .on("start", function (event, id) {
      this._cgDragged = false;
      // Shift always means "select an area", even starting on a node —
      // see the rubber-band block above boxDrag. A plain shift+click
      // (no movement) still falls through to the toggle-selection logic
      // in "end" below, once the (harmlessly empty) selection rect this
      // creates is torn back down there.
      if (event.sourceEvent && event.sourceEvent.shiftKey) {
        this._cgRubberBand = true;
        rbStart(event);
        return;
      }
      this._cgRubberBand = false;
      d3.select(this.parentNode).raise();
      var modifierHeld = event.sourceEvent && (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey);
      if (!modifierHeld && !selectedIds.has(id)) {
        selectedIds.clear();
        updateSelectionHighlight();
      }
    })
    .on("drag", function (event, id) {
      this._cgDragged = true;
      if (this._cgRubberBand) {
        rbDrag(event);
        return;
      }
      var dx = event.dx / currentZoomK;
      var dy = event.dy / currentZoomK;
      if (selectedIds.has(id) && selectedIds.size > 1) {
        selectedIds.forEach(function (sid) {
          pos[sid].x += dx;
          pos[sid].y += dy;
        });
      } else {
        pos[id].x += dx;
        pos[id].y += dy;
      }
      redraw();
    })
    .on("end", function (event, id) {
      var wasRubberBand = this._cgRubberBand;
      this._cgRubberBand = false;
      if (wasRubberBand && this._cgDragged) {
        rbEnd(event);
        return;
      }
      if (wasRubberBand && selectionRectEl) {
        // Shift+click, no movement: drop the zero-size rect started in
        // "start" and fall through to the toggle logic below.
        selectionRectEl.remove();
        selectionRectEl = null;
      }
      if (this._cgDragged) return;
      var modifierHeld =
        event.sourceEvent &&
        (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey || event.sourceEvent.shiftKey);
      if (modifierHeld) {
        if (selectedIds.has(id)) {
          selectedIds.delete(id);
        } else {
          selectedIds.add(id);
        }
        updateSelectionHighlight();
        return;
      }
      // Plain click (no modifier, no drag): toggle this node's
      // incoming/outgoing highlight; clicking the already-focused node
      // again clears it.
      focusedId = focusedId === id ? null : id;
      updateFocusHighlight();
    });
  var nodeMarkers = nodeG.select(".cg-node-marker");
  nodeMarkers.call(nodeDrag);

  clusters.select("rect").call(boxDrag);

  // Rubber-band select: shift+drag anywhere — empty canvas, a module box,
  // or a node — draws a selection box (boxDrag/nodeDrag above delegate to
  // the same rbStart/rbDrag/rbEnd used here when they see shiftKey);
  // every node whose center falls inside it becomes draggable as a group
  // (via nodeDrag above). Shift is required so this doesn't fight the
  // existing plain-drag-to-pan behavior on the same background.
  //
  // Also excludes text/tspan targets — without this, a mousedown starting
  // on a label (no longer caught by node/module drag above, now that
  // those are marker/rect-only) would bubble up and start a pan instead,
  // which would swallow the text-selection gesture just as effectively.
  // This only governs drag/dblclick/touch gestures now — wheel gestures
  // are filtered separately just below, since they need the opposite
  // rule (pan everywhere, INCLUDING over text) rather than this one.
  zoom.filter(function (event) {
    if (event.type === "wheel") return event.ctrlKey;
    var tag = event.target && event.target.tagName;
    var isText = tag === "text" || tag === "tspan";
    return !event.ctrlKey && !event.button && !event.shiftKey && !isText;
  });

  // Two-finger trackpad scroll (or a plain mouse wheel) always PANS, no
  // matter what element it lands on — a node, a module box, or a label —
  // unlike drag, which moves whatever it starts on. Chrome/Firefox mark a
  // real pinch gesture (and ctrl+scroll) with ctrlKey on the wheel event
  // specifically so it's distinguishable from an ordinary two-finger
  // scroll; the filter above routes that case to d3.zoom's own built-in
  // cursor-anchored scale handling instead, so only the non-pinch case
  // reaches here.
  //
  // Registered on its own "wheel.pan" namespace (not "wheel", which
  // svg.call(zoom) above already owns as "wheel.zoom") so both listeners
  // run independently per event rather than one replacing the other.
  //
  // zoom.translateBy's own x/y are pre-scale units (it internally applies
  // `+ k * x`), so screen-pixel wheel deltas are divided by currentZoomK
  // first — same reasoning as the drag handlers' dx/currentZoomK above —
  // to keep one wheel "tick" feeling like the same on-screen distance at
  // any zoom level. Negated to match this app's existing drag-to-pan feel
  // (and every other pannable-canvas tool's convention): scrolling down/
  // right moves the CONTENT up/left, revealing more of what's below/right
  // of the current view.
  svg.on("wheel.pan", function (event) {
    if (event.ctrlKey) return;
    event.preventDefault();
    zoom.translateBy(svg, -event.deltaX / currentZoomK, -event.deltaY / currentZoomK);
  });

  var selectDrag = d3
    .drag()
    .filter(function (event) {
      return event.shiftKey;
    })
    .on("start", rbStart)
    .on("drag", rbDrag)
    .on("end", rbEnd);
  svg.call(selectDrag);

  svg.on("click", function (event) {
    if (event.target !== svg.node()) return;
    if (selectedIds.size) {
      selectedIds.clear();
      updateSelectionHighlight();
    }
    if (selectedBoxIds.size) {
      selectedBoxIds.clear();
      updateBoxSelectionHighlight();
    }
    if (focusedId) {
      focusedId = null;
      updateFocusHighlight();
    }
  });

  function applyFilters() {
    var query = (searchInput.value || "").toLowerCase();

    nodeG.style("display", function (id) {
      if (collapsed[boxOf[id]]) return "none";
      if (query && id.toLowerCase().indexOf(query) === -1) return "none";
      return null;
    });

    edgePaths.style("display", function (e) {
      var hide =
        collapsed[boxOf[e.fromId]] ||
        collapsed[boxOf[e.toId]] ||
        (query &&
          e.fromId.toLowerCase().indexOf(query) === -1 &&
          e.toId.toLowerCase().indexOf(query) === -1);
      return hide ? "none" : null;
    });

    clusters.style("opacity", function (id) {
      var base = isCallerBox(id) ? 0.5 : 1;
      return collapsed[id] ? 0.35 * base : base;
    });
  }

  searchInput.addEventListener("input", applyFilters);

  moduleLabelToggle.addEventListener("change", function () {
    cgShowModuleLabels = moduleLabelToggle.checked;
    nodeG.selectAll(".cg-module-label").style("display", cgShowModuleLabels ? null : "none");
  });
}

window.CodegraphHooks.GraphViz = {
  mounted() {
    this.renderFromDataset();
  },
  updated() {
    this.renderFromDataset();
  },
  renderFromDataset() {
    var raw = this.el.dataset.graph;
    if (!raw) return;
    try {
      cgRenderGraph(this.el, JSON.parse(raw));
    } catch (err) {
      console.error("codegraph: failed to render graph", err);
      this.el.innerHTML =
        '<p style="color:#f66; padding:1rem;">Render error: ' +
        String(err) +
        "</p>";
    }
  },
};
