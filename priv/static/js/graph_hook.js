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

var CG_STATUS_COLOR = {
  added: "#3fb950",
  removed: "#f85149",
  modified: "#d29922",
};

var CG_BADGE_GAP = 34; // vertical gap between a module's badge and its topmost node

function cgRenderGraph(container, data) {
  container.innerHTML = "";
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
    '<span style="opacity:0.5; font-size:11px;">drag a node, or a module\'s label to move all its nodes · shift+drag to select an area, ctrl/cmd+click to select one at a time · click a label to collapse</span>';
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
      return n.function;
    })
    .forEach(ensureNode);

  var edgeList = []; // {fromId, toId, status}
  data.edges.forEach(function (e) {
    var a = ensureNode(e.from);
    var b = ensureNode(e.to);
    var fromId = cgNodeId(e.from);
    var toId = cgNodeId(e.to);
    edgeList.push({ fromId: fromId, toId: toId, status: e.status });
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
  var pos = {};
  Array.from(graph.nodes()).forEach(function (n) {
    pos[n.data] = { x: n.x, y: n.y };
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
      Array.from(graph.nodes()).map(function (n) {
        return Math.round(n.y * 100) / 100;
      })
    )
  ).sort(function (a, b) {
    return a - b;
  });
  var layerIndexByY = {};
  layerYs.forEach(function (y, i) {
    layerIndexByY[y] = i;
  });
  // Floor raised from 60 to 70: labels can now be two lines (signature +
  // return type), so a row needs a bit more clearance than a single line
  // did to avoid touching the next depth level down.
  var levelSpacing = Math.max(viewportHeight / layerYs.length, 70);
  Object.keys(pos).forEach(function (id) {
    var layerIndex = layerIndexByY[Math.round(pos[id].y * 100) / 100];
    pos[id].y = (layerIndex + 0.5) * levelSpacing;
  });

  var byModuleIds = {};
  Object.keys(nodesById).forEach(function (id) {
    if (!pos[id]) return; // external node with no position (shouldn't happen for function nodes)
    var mod = nodesById[id].module;
    (byModuleIds[mod] = byModuleIds[mod] || []).push(id);
  });
  var modules = Object.keys(byModuleIds);
  var color = d3.scaleOrdinal(d3.schemeTableau10).domain(modules);

  function translateModule(mod, dx, dy) {
    byModuleIds[mod].forEach(function (id) {
      pos[id].x += dx;
      pos[id].y += dy;
    });
  }

  // A module's functions can end up anywhere sugiyama's crossing-
  // minimization happens to put them — there's no notion of "keep this
  // module's nodes together" — so drawing one bounding box around a
  // module's full scatter routinely produces a big box around two nodes
  // sitting far apart, mostly empty space. Module identity is already
  // shown by node color, so instead of a box: a small floating label,
  // anchored above whichever of the module's nodes is closest to the
  // root (lowest y), used as the drag handle / collapse target.
  function moduleAnchor(mod) {
    var ids = byModuleIds[mod];
    var top = ids[0];
    ids.forEach(function (id) {
      if (pos[id].y < pos[top].y) top = id;
    });
    return pos[top];
  }

  function contentExtent() {
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    Object.keys(pos).forEach(function (id) {
      var p = pos[id];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    // -90/+200 for label width, -50 to leave room for badges above the
    // topmost nodes.
    return { minX: minX - 90, maxX: maxX + 200, minY: minY - 50, maxY: maxY };
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

  var zoom = d3.zoom().on("zoom", function (event) {
    zoomLayer.attr("transform", event.transform);
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

  var clusters = clusterLayer.selectAll("g").data(modules).join("g");

  clusters
    .append("rect")
    .attr("rx", 6)
    .attr("height", 22)
    .attr("fill", "#16161c")
    .attr("fill-opacity", 0.92)
    .attr("stroke", function (mod) {
      return color(mod);
    })
    .attr("stroke-width", 1.2)
    .style("cursor", "grab");

  clusters
    .append("text")
    .attr("x", 8)
    .attr("y", 15)
    .attr("fill", function (mod) {
      return color(mod);
    })
    .attr("font-size", 11)
    .attr("font-family", "ui-monospace, monospace")
    .style("cursor", "text")
    .text(function (mod) {
      return mod;
    })
    .on("click", function (event, mod) {
      collapsed[mod] = !collapsed[mod];
      applyFilters();
    });

  var badgeWidth = {};
  clusters.each(function (mod) {
    var g = d3.select(this);
    var bbox = g.select("text").node().getBBox();
    var w = bbox.width + 16;
    badgeWidth[mod] = w;
    g.select("rect").attr("width", w);
  });

  var collapsed = {};

  // Smooth top-to-bottom curves (the classic tree-diagram look), not
  // straight lines — d3-dag's own precomputed multi-point paths aren't
  // usable here since dragging/overlap-resolution move nodes independently
  // of the original static layout, so edges are recomputed live from
  // current positions on every redraw.
  var linkGen = d3
    .linkVertical()
    .x(function (d) {
      return d.x;
    })
    .y(function (d) {
      return d.y;
    });

  function edgePathD(fromId, toId) {
    var a = pos[fromId],
      b = pos[toId];
    if (!a || !b) return "";
    return linkGen({ source: a, target: b });
  }

  var edgePaths = edgeLayer
    .selectAll("path")
    .data(edgeList)
    .join("path")
    .attr("fill", "none")
    .attr("stroke", function (e) {
      return CG_STATUS_COLOR[e.status] || "#8a8a92";
    })
    .attr("stroke-width", function (e) {
      return e.status in CG_STATUS_COLOR ? 2 : 1.4;
    })
    .attr("stroke-dasharray", function (e) {
      return e.status === "removed" ? "4,3" : null;
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
    if (info.external) return "#777";
    return CG_STATUS_COLOR[info.status] || "#fff";
  }

  function nodeStrokeWidth(id) {
    if (selectedIds.has(id)) return 3;
    return CG_STATUS_COLOR[nodesById[id].status] ? 2 : 1.3;
  }

  function updateSelectionHighlight() {
    nodeG.select("circle").attr("stroke", nodeStroke).attr("stroke-width", nodeStrokeWidth);
  }

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
      if (info.external) return "#3a3a3f";
      return CG_STATUS_COLOR[info.status] || color(info.module);
    })
    .attr("stroke", nodeStroke)
    .attr("stroke-width", nodeStrokeWidth)
    .attr("stroke-dasharray", function (id) {
      return nodesById[id].status === "removed" ? "3,2" : null;
    })
    .attr("opacity", function (id) {
      return nodesById[id].external ? 0.55 : 1;
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
      if (info.external) return "#8a8a92";
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
        .attr("fill", info.external ? "#666" : color(info.module))
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

    clusters.attr("transform", function (mod) {
      var a = moduleAnchor(mod);
      var w = badgeWidth[mod] || 0;
      return "translate(" + (a.x - w / 2) + "," + (a.y - CG_BADGE_GAP) + ")";
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
  var moduleDrag = d3
    .drag()
    .clickDistance(6)
    .on("start", function () {
      d3.select(this.parentNode).raise();
    })
    .on("drag", function (event, mod) {
      translateModule(mod, event.dx, event.dy);
      redraw();
    });

  // Individual nodes are draggable too, independent of their module's
  // badge (which still drags every node in that module together). No
  // module box remains to imply "drag this whole region", so with the
  // box gone the node itself is the thing you'd naturally reach for.
  //
  // Dragging a node that's part of the current selection (built via
  // shift+drag-an-area, or ctrl/cmd+click below) moves every selected
  // node together; dragging any other node clears the selection first
  // and moves just that one, same as before selection existed at all.
  // A ctrl/cmd-held drag start skips that auto-clear, since holding the
  // modifier means the user is trying to grow/shrink the selection (via
  // the click handler below), not replace it.
  var nodeDrag = d3
    .drag()
    .on("start", function (event, id) {
      d3.select(this.parentNode).raise();
      var modifierHeld = event.sourceEvent && (event.sourceEvent.ctrlKey || event.sourceEvent.metaKey);
      if (!modifierHeld && !selectedIds.has(id)) {
        selectedIds.clear();
        updateSelectionHighlight();
      }
    })
    .on("drag", function (event, id) {
      if (selectedIds.has(id) && selectedIds.size > 1) {
        selectedIds.forEach(function (sid) {
          pos[sid].x += event.dx;
          pos[sid].y += event.dy;
        });
      } else {
        pos[id].x += event.dx;
        pos[id].y += event.dy;
      }
      redraw();
    });
  var nodeCircles = nodeG.select("circle");
  nodeCircles.call(nodeDrag);

  // Ctrl/cmd+click toggles one node in or out of the selection without
  // disturbing the rest of it — the way to build up an arbitrary
  // multi-node selection one click at a time, as opposed to shift+drag
  // which selects everything in a drawn area at once. A plain click (no
  // modifier) needs no handler here: nodeDrag's "start" above already
  // clears the selection on an unmodified click, and d3-drag still lets
  // the browser's own click event through afterward when the gesture
  // didn't actually move (its default clickDistance is 0).
  nodeCircles.on("click", function (event, id) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    updateSelectionHighlight();
  });

  clusters.select("rect").call(moduleDrag);

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
      var info = nodesById[id];
      if (collapsed[info.module]) return "none";
      if (query && id.toLowerCase().indexOf(query) === -1) return "none";
      return null;
    });

    edgePaths.style("display", function (e) {
      var hide =
        collapsed[nodesById[e.fromId].module] ||
        collapsed[nodesById[e.toId].module] ||
        (query &&
          e.fromId.toLowerCase().indexOf(query) === -1 &&
          e.toId.toLowerCase().indexOf(query) === -1);
      return hide ? "none" : null;
    });

    clusters.style("opacity", function (mod) {
      return collapsed[mod] ? 0.35 : 1;
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
