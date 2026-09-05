// Pure layout math: turns the raw {nodes, edges} scope data into node
// positions and module "box" groupings, with no DOM/d3-selection work at
// all (that part lives in graph_hook.js, which calls cgComputeLayout and
// destructures its return value into the same local names this used to
// use back when both lived in one function). Depends on graph_shared.js
// (cgNodeId, cgLabelWidth, cgBoxLabelWidth, BOX_PAD_X et al) and on the
// d3/d3-dag globals loaded ahead of it.
function cgComputeLayout(data) {
  var nodesById = {};
  data.nodes
    .filter(function (n) {
      return n.function;
    })
    .forEach(function (n) {
      nodesById[cgNodeId(n)] = n;
    });

  // A module's own diff status (from its `defmodule` node, `function:
  // null`) — read directly rather than inferred from its member
  // functions' own statuses, since a module with a few modified
  // functions among many unchanged ones is the common case and does NOT
  // mean the whole module was added or removed. Only meaningful (used by
  // the box-background highlight in graph_hook.js) when it's `"added"`
  // or `"removed"`: the module itself didn't exist on one side at all.
  var moduleStatus = {};
  data.nodes.forEach(function (n) {
    if (!n.function) moduleStatus[n.module] = n.status;
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
  // by every draw call in graph_hook.js, so dragging and overlap
  // resolution can move nodes freely without needing to touch the
  // underlying d3-dag layout.
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

  // BOX_PAD_X/BOX_PAD_TOP/BOX_PAD_BOTTOM/NODE_HALF_ROW live in
  // graph_shared.js now — graph_hook.js's boxRect must reserve exactly
  // the same padding when it draws each box's rectangle, so both files
  // read them from that one shared definition rather than risking two
  // copies drifting apart.

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

    // Floored at 120 to match boxRect's own per-node minimum in
    // graph_hook.js — reserving only the raw (unfloored) label width here
    // left short-labeled nodes (an external leaf like "each/2", say) with
    // a narrower reservation than the rectangle boxRect actually draws
    // for them, so two short-labeled sibling boxes could still overlap.
    var contentWidth = Math.max.apply(
      null,
      members.map(function (id) {
        return Math.max(cgLabelWidth(nodesById[id]), 120);
      })
    );
    // Reserve exactly what boxRect will actually draw: content padded by
    // BOX_PAD_X on both sides, widened further on the right if the
    // module's own label (which can be wider than its content — see
    // cgBoxLabelWidth) needs more room than that. Reserving only the raw
    // content width here — leaving BOX_PAD_X to be added purely at draw
    // time — left every drawn rectangle wider than what TREE_GAP had
    // actually set aside for it, so adjacent boxes' rectangles
    // overlapped even where the underlying node positions didn't.
    // A caller box's own key carries the "caller:" prefix (see
    // CG_CALLER_BOX_PREFIX above) so it can't collide with a downward-tree
    // box for the same module — but the LABEL actually drawn (see
    // boxModule in graph_hook.js) is just the bare module name, so the
    // width reserved for it here has to strip the prefix too, or every
    // caller box would reserve several extra characters' worth of width
    // it never draws.
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

  return {
    nodesById: nodesById,
    callerOnlyIds: callerOnlyIds,
    edgeList: edgeList,
    callerEdgeList: callerEdgeList,
    pos: pos,
    boxOf: boxOf,
    boxMembers: boxMembers,
    boxIds: boxIds,
    boxModule: boxModule,
    moduleStatus: moduleStatus,
    isCallerBox: isCallerBox,
    color: color,
  };
}
