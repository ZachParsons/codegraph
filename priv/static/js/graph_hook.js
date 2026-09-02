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

// Escape clears both node selection and any active browser text
// selection. Tracked at module scope (not just inside cgRenderGraph) so a
// re-render (filter change, diff reload, etc.) can remove the PREVIOUS
// render's listener before adding a new one — otherwise every re-render
// would leak another document-level listener, each holding a closure
// over that render's now-stale selectedIds/updateSelectionHighlight.
var cgEscListener = null;

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
    '<span style="opacity:0.5; font-size:11px;">drag a node, or a module\'s label to move all its nodes · shift+drag to select an area, shift or ctrl/cmd+click to select one at a time, esc to clear · click a label to collapse</span>';
  container.appendChild(toolbar);
  var searchInput = toolbar.querySelector("input");

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

  // 1.5x beyond the raw viewport-height/level-count split, floor raised
  // 70->110: rows were still reading as cramped. The graph no longer
  // necessarily fits the viewport vertically without scrolling/panning
  // once depth is more than a handful of levels — an intentional
  // trade-off for more breathing room per row, not the earlier goal of
  // exactly filling the viewport at any level count.
  var levelSpacing = Math.max((viewportHeight / layerYs.length) * 1.5, 110);
  Object.keys(pos).forEach(function (id) {
    pos[id].y = (nodeLayer[id] + 0.5) * levelSpacing;
  });

  // Tidy-tree horizontal placement: nodes are first grouped into "boxes" —
  // a box is a maximal run of directly-connected same-module nodes along
  // the spanning tree (a straight chain, or a small branching sub-tree,
  // all in one module) — then BOXES, not individual nodes, are the units
  // a Reingold-Tilford-with-contour-merge places left to right, each
  // parent box centered over its own child boxes with no overlap. A
  // module whose functions appear in several disconnected places in the
  // call tree gets several separate boxes, one per occurrence — there's
  // no single global "the Foo module" region, only wherever a same-module
  // chain actually occurs, which is also what lets a widely-shared callee
  // (a stdlib helper, say) stay a single node with multiple incoming
  // edges rather than needing to be duplicated per caller.
  //
  // A general DAG isn't a tree, though (a node can have more than one
  // caller) — so this first picks ONE spanning tree out of it via DFS
  // from the layer-0 roots, in call order (edgeList's order): a node
  // reached by more than one caller is positioned under whichever
  // caller's DFS found it first (and so belongs to whichever box that
  // caller occurs in), and its OTHER callers still get their edge drawn
  // to wherever it ends up, without influencing that position themselves.
  var childrenOf = {};
  edgeList.forEach(function (e) {
    if (!pos[e.fromId] || !pos[e.toId] || e.fromId === e.toId) return;
    (childrenOf[e.fromId] = childrenOf[e.fromId] || []).push(e.toId);
  });

  var treeVisited = {};
  var treeChildrenOf = {};
  var treeRoots = [];
  var parentOf = {};
  function visitForTree(id, parent) {
    if (treeVisited[id]) return;
    treeVisited[id] = true;
    if (parent === undefined) {
      treeRoots.push(id);
    } else {
      parentOf[id] = parent;
      (treeChildrenOf[parent] = treeChildrenOf[parent] || []).push(id);
    }
    (childrenOf[id] || []).forEach(function (childId) {
      // A node reachable via more than one caller must be claimed by a
      // caller whose OWN layer is consistent with it — otherwise this
      // DFS (which explores fully before backtracking to a sibling) can
      // claim it under a LONGER real path before its true shortest-path
      // caller (elsewhere in the walk) ever gets the chance, stranding
      // it a row below where `level` (a shortest-hop BFS count — see
      // Codegraph.Scope.scope/4) actually puts it, which visibly
      // conflicts with whichever OTHER node legitimately occupies that
      // row. With a real `level` present, "consistent" means exactly
      // one row deeper (`level` is a hop count, not just monotonic); the
      // unscoped whole-project view has no such `level` and falls back
      // to sugiyama's own layer, which only guarantees a child's layer
      // is GREATER, not exactly +1 (see the layer-assignment note above).
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

  // Box assignment: walk the spanning tree top-down; a node continues its
  // parent's box when they're in the same module, otherwise it starts a
  // new one. `boxMembers` is in DFS/call order, matching edgeList's own
  // order (see the note above on why that matters for layout).
  var boxOf = {};
  var boxMembers = {};
  function assignBox(id, currentBox) {
    var sameModuleAsParent =
      parentOf[id] !== undefined && nodesById[id].module === nodesById[parentOf[id]].module;
    var box = sameModuleAsParent ? currentBox : id;
    boxOf[id] = box;
    (boxMembers[box] = boxMembers[box] || []).push(id);
    (treeChildrenOf[id] || []).forEach(function (childId) {
      assignBox(childId, box);
    });
  }
  treeRoots.forEach(function (id) {
    assignBox(id, id);
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
  // Contour merging fixes this by comparing, layer by layer, the RIGHT
  // silhouette of everything already placed against the LEFT silhouette
  // of the next subtree, and shifting the new subtree only as far right
  // as the tightest shared layer actually requires — not by its total
  // width. Two subtrees that are both narrow at some deep layer can
  // interleave closely there even if one of them is wide higher up.
  //
  // A box, though, reserves its OWN full width (not each row's own
  // narrower content) at EVERY layer it spans, uniformly — otherwise a
  // neighboring box could tuck in close at one of this box's narrower
  // rows and end up visually inside its drawn rectangle at a wider row
  // above or below. This is computed in two passes: `layoutBoxLocal`
  // first lays out a box's own same-module descendants only, giving its
  // real internal shape and overall width; `layoutBox` then treats the
  // box as the atomic unit for the OUTER merge, contributing that width
  // uniformly across all its layers, with each cross-module child (an
  // "exit") recursively becoming another box.
  //
  // Contours are keyed by ABSOLUTE layer number (nodeLayer[id]), not by
  // depth-relative-to-this-subtree's-own-root — an earlier version of
  // this used relative depth and was verified to still produce real
  // overlaps (up to 105px, on real data): sugiyama layering can skip
  // layers along a single tree edge (a child isn't guaranteed to be
  // exactly parent-layer+1, only >), and separate root subtrees (a node
  // never reached from a layer-0 root becomes its own root, whatever
  // layer it's actually at) don't all start at layer 0 either — so
  // "relative depth 0 vs relative depth 0" was comparing nodes that
  // often weren't even at the same visual row, missing real collisions
  // at their true shared layers. Plain objects (not arrays) hold the
  // per-layer values so gaps don't need explicit padding.
  var TREE_GAP = 24;

  // Shared by layoutBoxLocal/layoutBox below (and by the root-level merge
  // further down): places `childLayouts` left to right, shifting each one
  // just far enough right that, at every ABSOLUTE layer where it and
  // everything already placed both have a contour, they're at least
  // TREE_GAP apart.
  function mergeChildrenLeftToRight(childLayouts) {
    var offsets = new Array(childLayouts.length);
    var combinedLeft = {};
    var combinedRight = {};
    childLayouts.forEach(function (cl, i) {
      var shift = 0;
      if (i > 0) {
        Object.keys(cl.leftContour).forEach(function (layer) {
          if (!combinedRight.hasOwnProperty(layer)) return;
          var needed = combinedRight[layer] + TREE_GAP - cl.leftContour[layer];
          if (needed > shift) shift = needed;
        });
      }
      offsets[i] = shift;
      Object.keys(cl.leftContour).forEach(function (layer) {
        var lv = cl.leftContour[layer] + shift;
        var rv = cl.rightContour[layer] + shift;
        if (combinedLeft.hasOwnProperty(layer)) {
          if (lv < combinedLeft[layer]) combinedLeft[layer] = lv;
          if (rv > combinedRight[layer]) combinedRight[layer] = rv;
        } else {
          combinedLeft[layer] = lv;
          combinedRight[layer] = rv;
        }
      });
    });
    return { offsets: offsets, combinedLeft: combinedLeft, combinedRight: combinedRight };
  }

  // A box's own internal layout: same contour algorithm as before,
  // restricted to same-box (same-module) children only. Gives each
  // member's position relative to the box's own root, and the box's real
  // per-layer left/right silhouette — used by layoutBox below to derive
  // its overall reserved width.
  function layoutBoxLocal(id) {
    var ownHalf = cgLabelWidth(nodesById[id]) / 2;
    var myLayer = nodeLayer[id];
    var kids = (treeChildrenOf[id] || []).filter(function (c) {
      return boxOf[c] === boxOf[id];
    });

    if (!kids.length) {
      var leafRelX = {};
      leafRelX[id] = 0;
      var leafLeft = {};
      var leafRight = {};
      leafLeft[myLayer] = -ownHalf;
      leafRight[myLayer] = ownHalf;
      return { leftContour: leafLeft, rightContour: leafRight, relX: leafRelX };
    }

    var childLayouts = kids.map(layoutBoxLocal);
    var merged = mergeChildrenLeftToRight(childLayouts);

    var relX = {};
    childLayouts.forEach(function (cl, i) {
      Object.keys(cl.relX).forEach(function (nid) {
        relX[nid] = cl.relX[nid] + merged.offsets[i];
      });
    });

    // Center this node over its first and last direct child's actual
    // (now-placed) position, same centering rule as before.
    var firstKidX = relX[kids[0]];
    var lastKidX = relX[kids[kids.length - 1]];
    var nodeX = (firstKidX + lastKidX) / 2;

    relX[id] = 0;
    Object.keys(relX).forEach(function (nid) {
      if (nid !== id) relX[nid] -= nodeX;
    });

    var leftContour = {};
    var rightContour = {};
    leftContour[myLayer] = -ownHalf;
    rightContour[myLayer] = ownHalf;
    Object.keys(merged.combinedLeft).forEach(function (layer) {
      leftContour[layer] = merged.combinedLeft[layer] - nodeX;
      rightContour[layer] = merged.combinedRight[layer] - nodeX;
    });

    return { leftContour: leftContour, rightContour: rightContour, relX: relX };
  }

  // The outer layout: boxes (not individual nodes) are the units placed
  // left to right. A box's "children", for this purpose, are the OTHER
  // boxes reached by a cross-module edge ("exit") from ANY of its own
  // members (flattened in box-member order, which is call order) — each
  // recursively laid out the same way. The box contributes a UNIFORM
  // left/right silhouette at every layer it spans (its own overall width,
  // from layoutBoxLocal above), not its real per-row width, so a
  // neighboring box can never tuck into one of its narrower rows.
  function layoutBox(boxId) {
    var local = layoutBoxLocal(boxId);
    var layers = Object.keys(local.leftContour).map(Number);
    var boxLeft = Math.min.apply(
      null,
      layers.map(function (l) {
        return local.leftContour[l];
      })
    );
    var boxRight = Math.max.apply(
      null,
      layers.map(function (l) {
        return local.rightContour[l];
      })
    );
    // The box's own label can be wider than its content (see
    // cgBoxLabelWidth) — reserve for that too, growing only to the
    // right, matching how boxRect below draws it (left edge fixed).
    boxRight = Math.max(boxRight, boxLeft + cgBoxLabelWidth(nodesById[boxId].module));

    var exitBoxIds = [];
    boxMembers[boxId].forEach(function (memberId) {
      (treeChildrenOf[memberId] || []).forEach(function (childId) {
        if (boxOf[childId] !== boxId) exitBoxIds.push(childId);
      });
    });

    if (!exitBoxIds.length) {
      var leftOnly = {};
      var rightOnly = {};
      layers.forEach(function (l) {
        leftOnly[l] = boxLeft;
        rightOnly[l] = boxRight;
      });
      return { leftContour: leftOnly, rightContour: rightOnly, relX: local.relX };
    }

    // A pseudo "self" entry, fixed first (mergeChildrenLeftToRight never
    // shifts the first item), representing the box's own uniform
    // footprint at its own layers. Exits are placed relative to it via
    // the SAME merge, so one that lands at the same absolute layer as
    // the box's own internal content — very common: an external call
    // made directly from the box's root sits at the same layer as the
    // box's other same-module siblings — still ends up TREE_GAP clear of
    // it, instead of only ever being checked against other exits.
    var selfEntry = { leftContour: {}, rightContour: {}, relX: {} };
    layers.forEach(function (l) {
      selfEntry.leftContour[l] = boxLeft;
      selfEntry.rightContour[l] = boxRight;
    });

    var exitLayouts = exitBoxIds.map(layoutBox);
    var merged = mergeChildrenLeftToRight([selfEntry].concat(exitLayouts));

    var relX = {};
    Object.keys(local.relX).forEach(function (nid) {
      relX[nid] = local.relX[nid];
    });
    exitLayouts.forEach(function (cl, i) {
      var offset = merged.offsets[i + 1]; // +1: offsets[0] is the self entry
      Object.keys(cl.relX).forEach(function (nid) {
        relX[nid] = cl.relX[nid] + offset;
      });
    });

    var firstX = relX[exitBoxIds[0]];
    var lastX = relX[exitBoxIds[exitBoxIds.length - 1]];
    var nodeX = (firstX + lastX) / 2;

    Object.keys(relX).forEach(function (nid) {
      relX[nid] -= nodeX;
    });

    var leftContour = {};
    var rightContour = {};
    Object.keys(merged.combinedLeft).forEach(function (layer) {
      leftContour[layer] = merged.combinedLeft[layer] - nodeX;
      rightContour[layer] = merged.combinedRight[layer] - nodeX;
    });

    return { leftContour: leftContour, rightContour: rightContour, relX: relX };
  }

  // Same contour-merge logic applies one level up, to place the separate
  // root boxes (Broadway's own entry box, say) against each other — an
  // imaginary shared parent isn't needed, just the same left-to-right
  // contour comparison used for sibling boxes above.
  var rootLayouts = treeRoots.map(layoutBox);
  var rootMerged = mergeChildrenLeftToRight(rootLayouts);

  treeRoots.forEach(function (id, i) {
    var rl = rootLayouts[i];
    Object.keys(rl.relX).forEach(function (nid) {
      pos[nid].x = rl.relX[nid] + rootMerged.offsets[i];
    });
  });

  // Callers of the root(s) — exactly one generation, never fed through
  // sugiyama or the downward contour merge above (see callerOnlyIds) —
  // get their own row placed directly above the root they call, entirely
  // by hand: pack each root's callers into a row centered on that root's
  // now-final x, in call order, then resolve left-right overlap BETWEEN
  // different roots' caller rows by shifting a later row rightward. A
  // root's own x never moves for this, only its callers shift, so a
  // crowded caller row can end up off-center under its root — an
  // acceptable trade-off for leaving the already-finalized downward tree
  // layout completely undisturbed by this separate upward pass. A caller
  // shared by more than one root is placed once, under whichever root
  // claims it first.
  var callersByRoot = {};
  var callerClaimedBy = {};
  callerEdgeList.forEach(function (e) {
    if (!pos[e.toId] || callerClaimedBy[e.fromId] !== undefined) return;
    callerClaimedBy[e.fromId] = e.toId;
    (callersByRoot[e.toId] = callersByRoot[e.toId] || []).push(e.fromId);
  });

  var callerRows = Object.keys(callersByRoot).map(function (rootId) {
    var callerIds = callersByRoot[rootId];
    var widths = callerIds.map(function (id) {
      return Math.max(cgLabelWidth(nodesById[id]), 120);
    });
    var totalWidth =
      widths.reduce(function (a, b) {
        return a + b;
      }, 0) +
      TREE_GAP * (callerIds.length - 1);
    var startX = pos[rootId].x - totalWidth / 2;
    var xs = [];
    var cursor = startX;
    widths.forEach(function (w) {
      xs.push(cursor + w / 2);
      cursor += w + TREE_GAP;
    });
    return {
      callerIds: callerIds,
      xs: xs,
      y: pos[rootId].y - levelSpacing,
      left: startX,
      right: cursor - TREE_GAP,
    };
  });

  callerRows.sort(function (a, b) {
    return a.left - b.left;
  });
  var callerRowPrevRight = -Infinity;
  callerRows.forEach(function (row) {
    var shift = Math.max(0, callerRowPrevRight + TREE_GAP - row.left);
    if (shift > 0) {
      row.xs = row.xs.map(function (x) {
        return x + shift;
      });
      row.left += shift;
      row.right += shift;
    }
    callerRowPrevRight = row.right;
  });

  callerRows.forEach(function (row) {
    row.callerIds.forEach(function (id, i) {
      pos[id] = { x: row.xs[i], y: row.y };
    });
  });

  // Callers never went through the box-assignment DFS above (they're
  // placed by hand, right above), so each one becomes its own singleton
  // box here — Codegraph.Scope only ever looks up one generation of
  // caller, so there's never a same-module chain to fold them into
  // anyway. This also sweeps up any other id with a position but no box
  // yet, for the same reason.
  Object.keys(pos).forEach(function (id) {
    if (!boxOf[id]) {
      boxOf[id] = id;
      boxMembers[id] = [id];
    }
  });

  var boxIds = Object.keys(boxMembers).filter(function (id) {
    return pos[id]; // external node with no position (shouldn't happen for function nodes)
  });
  var moduleNames = Array.from(
    new Set(
      boxIds.map(function (id) {
        return nodesById[id].module;
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
  // possible now because box assignment (above) already keeps a
  // same-module chain visually contiguous, and the box-aware contour
  // layout already reserves enough space that nothing else lands inside
  // it. Estimated (not DOM-measured) label width, so this can run before
  // any SVG text exists — used both for the initial viewport sizing
  // (contentExtent below) and every redraw.
  var BOX_PAD_X = 10;
  var BOX_PAD_TOP = 26;
  var BOX_PAD_BOTTOM = 10;
  var NODE_HALF_ROW = 28; // half a node's own rendered height (circle + multi-line label)

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
    var labelWidth = cgBoxLabelWidth(nodesById[boxId].module);
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

  svg
    .append("defs")
    .append("marker")
    .attr("id", "cg-arrow")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 17)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#8a8a92");

  var clusterLayer = root.append("g");
  var edgeLayer = root.append("g");
  var nodeLayer = root.append("g");

  // One rectangle per box (see box assignment above), not per module —
  // a module whose functions occur in several disconnected places in the
  // tree gets one rectangle per occurrence, each still colored/labeled by
  // its module name. A caller box (see callerOnlyIds) is dimmed and
  // dashed to read as implicit/background context, matching the ordinary
  // downward tree's full-contrast boxes.
  var clusters = clusterLayer
    .selectAll("g")
    .data(boxIds)
    .join("g")
    .style("opacity", function (id) {
      return callerOnlyIds.has(id) ? 0.5 : 1;
    });

  clusters
    .append("rect")
    .attr("rx", 8)
    .attr("fill", "#16161c")
    .attr("fill-opacity", 0.5)
    .attr("stroke", function (id) {
      return color(nodesById[id].module);
    })
    .attr("stroke-width", 1.2)
    .attr("stroke-dasharray", function (id) {
      return callerOnlyIds.has(id) ? "3,3" : null;
    })
    .style("cursor", "grab");

  clusters
    .append("text")
    .attr("x", 8)
    .attr("y", 15)
    .attr("fill", function (id) {
      return color(nodesById[id].module);
    })
    .attr("font-size", 11)
    .attr("font-family", "ui-monospace, monospace")
    .style("cursor", "text")
    .text(function (id) {
      return nodesById[id].module;
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
  function edgePathD(fromId, toId) {
    var a = pos[fromId],
      b = pos[toId];
    if (!a || !b) return "";
    return "M" + a.x + "," + a.y + "L" + b.x + "," + b.y;
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
  // Rubber-band multi-select state. Selected nodes get a highlighted
  // stroke — nodeStroke()/nodeStrokeWidth() are shared by the initial
  // circle creation below and by updateSelectionHighlight(), so both stay
  // in sync instead of duplicating the same status/external logic twice.
  var selectedIds = new Set();

  function nodeStroke(id) {
    if (selectedIds.has(id)) return "#4f9dff";
    var info = nodesById[id];
    if (info.external || callerOnlyIds.has(id)) return "#777";
    return CG_STATUS_COLOR[info.status] || "#fff";
  }

  function nodeStrokeWidth(id) {
    if (selectedIds.has(id)) return 3;
    return CG_STATUS_COLOR[nodesById[id].status] ? 2 : 1.3;
  }

  function updateSelectionHighlight() {
    nodeG.select("circle").attr("stroke", nodeStroke).attr("stroke-width", nodeStrokeWidth);
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
    .append("circle")
    .attr("r", function (id) {
      return CG_STATUS_COLOR[nodesById[id].status] ? 8 : 7;
    })
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
    .attr("opacity", function (id) {
      return nodesById[id].external || callerOnlyIds.has(id) ? 0.55 : 1;
    })
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
    .style("cursor", "text")
    .each(function (id) {
      var info = nodesById[id];
      var text = d3.select(this);

      text
        .append("tspan")
        .attr("x", 11)
        .attr("dy", -3)
        .attr("font-size", 9)
        .attr("fill", info.external || callerOnlyIds.has(id) ? "#666" : color(info.module))
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

  // Drag handles are the circle/rect only, never the text — a drag
  // behavior on an element swallows the mousedown+move gesture that
  // native browser text selection also needs, so attaching it to the
  // whole node/badge group (text included) made every label unselectable.
  // .raise() targets the parent <g> (not just the circle/rect it's
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
  var boxDrag = d3
    .drag()
    .container(function () {
      return svg.node();
    })
    .clickDistance(6)
    .on("start", function () {
      d3.select(this.parentNode).raise();
    })
    .on("drag", function (event, id) {
      translateBox(id, event.dx / currentZoomK, event.dy / currentZoomK);
      redraw();
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
      d3.select(this.parentNode).raise();
      this._cgDragged = false;
      var modifierHeld =
        event.sourceEvent &&
        (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey || event.sourceEvent.shiftKey);
      if (!modifierHeld && !selectedIds.has(id)) {
        selectedIds.clear();
        updateSelectionHighlight();
      }
    })
    .on("drag", function (event, id) {
      this._cgDragged = true;
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
      if (this._cgDragged) return;
      var modifierHeld =
        event.sourceEvent &&
        (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey || event.sourceEvent.shiftKey);
      if (!modifierHeld) return;
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      updateSelectionHighlight();
    });
  var nodeCircles = nodeG.select("circle");
  nodeCircles.call(nodeDrag);

  clusters.select("rect").call(boxDrag);

  // Rubber-band select: shift+drag on empty canvas draws a selection box;
  // every node whose center falls inside it becomes draggable as a group
  // (via nodeDrag above). Shift is required so this doesn't fight the
  // existing plain-drag-to-pan behavior on the same background.
  //
  // Also excludes text/tspan targets — without this, a mousedown starting
  // on a label (no longer caught by node/module drag above, now that
  // those are circle/rect-only) would bubble up and start a pan instead,
  // which would swallow the text-selection gesture just as effectively.
  zoom.filter(function (event) {
    var tag = event.target && event.target.tagName;
    var isText = tag === "text" || tag === "tspan";
    return (!event.ctrlKey || event.type === "wheel") && !event.button && !event.shiftKey && !isText;
  });

  var selectionStart = null;
  var selectionRectEl = null;

  var selectDrag = d3
    .drag()
    .filter(function (event) {
      return event.shiftKey;
    })
    .on("start", function (event) {
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
    })
    .on("drag", function (event) {
      var p = d3.pointer(event, root.node());
      var x = Math.min(selectionStart[0], p[0]);
      var y = Math.min(selectionStart[1], p[1]);
      selectionRectEl
        .attr("x", x)
        .attr("y", y)
        .attr("width", Math.abs(p[0] - selectionStart[0]))
        .attr("height", Math.abs(p[1] - selectionStart[1]));
    })
    .on("end", function (event) {
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
    });
  svg.call(selectDrag);

  svg.on("click", function (event) {
    if (event.target === svg.node() && selectedIds.size) {
      selectedIds.clear();
      updateSelectionHighlight();
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
      var base = callerOnlyIds.has(id) ? 0.5 : 1;
      return collapsed[id] ? 0.35 * base : base;
    });
  }

  searchInput.addEventListener("input", applyFilters);
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
