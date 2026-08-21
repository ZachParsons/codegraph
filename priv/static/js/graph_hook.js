window.CodegraphHooks = window.CodegraphHooks || {};

function cgNodeId(n) {
  return n.function ? n.module + "." + n.function + "/" + n.arity : n.module;
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
    '<span style="opacity:0.5; font-size:11px;">drag a module to move it · click its label to collapse it</span>';
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
  // the horizontal axis and roots off to one side instead of on top. A
  // wide call graph is still going to be wide here; that's what a wide
  // tree looks like. Pan/zoom is the answer, not fighting the axes.)
  var layout = d3.sugiyama().nodeSize(function () {
    return [190, 80];
  });
  var extent = layout(graph);

  // Mutable render-space position store — the single source of truth used
  // by every draw call below, so dragging and overlap resolution can move
  // nodes freely without needing to touch the underlying d3-dag layout.
  var pos = {};
  Array.from(graph.nodes()).forEach(function (n) {
    pos[n.data] = { x: n.x, y: n.y };
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

  var viewportHeight = Math.max(window.innerHeight - 140, 400);

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

  var containerWidth = container.clientWidth || 1000;
  var fitScale = Math.min(
    (containerWidth - 40) / (width + 110),
    (viewportHeight - 40) / (height + 70),
    1
  );

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

  var clusters = clusterLayer
    .selectAll("g")
    .data(modules)
    .join("g")
    .style("cursor", "grab");

  clusters
    .append("rect")
    .attr("rx", 6)
    .attr("height", 22)
    .attr("fill", "#16161c")
    .attr("fill-opacity", 0.92)
    .attr("stroke", function (mod) {
      return color(mod);
    })
    .attr("stroke-width", 1.2);

  clusters
    .append("text")
    .attr("x", 8)
    .attr("y", 15)
    .attr("fill", function (mod) {
      return color(mod);
    })
    .attr("font-size", 11)
    .attr("font-family", "ui-monospace, monospace")
    .style("cursor", "pointer")
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
    .attr("stroke", function (id) {
      var info = nodesById[id];
      if (info.external) return "#777";
      return CG_STATUS_COLOR[info.status] || "#fff";
    })
    .attr("stroke-width", function (id) {
      return CG_STATUS_COLOR[nodesById[id].status] ? 2 : 1.3;
    })
    .attr("stroke-dasharray", function (id) {
      return nodesById[id].status === "removed" ? "3,2" : null;
    })
    .attr("opacity", function (id) {
      return nodesById[id].external ? 0.55 : 1;
    });

  nodeG
    .append("text")
    .attr("x", 11)
    .attr("y", 4)
    .attr("font-family", "ui-monospace, monospace")
    .attr("font-size", 11)
    .attr("fill", function (id) {
      var info = nodesById[id];
      if (info.external) return "#8a8a92";
      return CG_STATUS_COLOR[info.status] || "#eee";
    })
    .text(function (id) {
      var info = nodesById[id];
      return info.function + "/" + info.arity;
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

  var moduleDrag = d3
    .drag()
    .clickDistance(6)
    .on("start", function () {
      d3.select(this).raise();
    })
    .on("drag", function (event, mod) {
      translateModule(mod, event.dx, event.dy);
      redraw();
    });
  clusters.call(moduleDrag);

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
