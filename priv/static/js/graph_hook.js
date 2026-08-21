window.CodegraphHooks = window.CodegraphHooks || {};

function cgNodeId(n) {
  return n.function ? n.module + "." + n.function + "/" + n.arity : n.module;
}

var CG_STATUS_COLOR = {
  added: "#3fb950",
  removed: "#f85149",
  modified: "#d29922",
};

var CG_PAD_X = 70;
var CG_PAD_Y = 24;
var CG_PAD_GAP = 12; // minimum gap enforced between separated module boxes

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
  // lays out with y = layer depth, x = spread within a layer — for a
  // typically shallow-but-wide call graph that means short and very wide.
  // Swapping x/y after layout (below) rotates it 90°: layers run left to
  // right (narrow, since depth is usually small) and same-layer nodes
  // stack top to bottom (tall, roomy for the common case of wide fan-out).
  var layout = d3.sugiyama().nodeSize(function () {
    return [44, 260];
  });
  var extent = layout(graph);

  // Mutable render-space position store — the single source of truth used
  // by every draw call below, so dragging and overlap resolution can move
  // nodes freely without needing to touch the underlying d3-dag layout.
  var pos = {};
  Array.from(graph.nodes()).forEach(function (n) {
    pos[n.data] = { x: n.y, y: n.x }; // swapped
  });

  var byModuleIds = {};
  Object.keys(nodesById).forEach(function (id) {
    if (!pos[id]) return; // external node with no position (shouldn't happen for function nodes)
    var mod = nodesById[id].module;
    (byModuleIds[mod] = byModuleIds[mod] || []).push(id);
  });
  var modules = Object.keys(byModuleIds);
  var color = d3.scaleOrdinal(d3.schemeTableau10).domain(modules);

  function moduleBounds(mod) {
    var ids = byModuleIds[mod];
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    ids.forEach(function (id) {
      var p = pos[id];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    return {
      minX: minX - CG_PAD_X,
      maxX: maxX + CG_PAD_X,
      minY: minY - CG_PAD_Y,
      maxY: maxY + CG_PAD_Y,
    };
  }

  function translateModule(mod, dx, dy) {
    byModuleIds[mod].forEach(function (id) {
      pos[id].x += dx;
      pos[id].y += dy;
    });
  }

  function overallAspect() {
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    modules.forEach(function (mod) {
      var b = moduleBounds(mod);
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
    });
    return Math.max((maxX - minX) / Math.max(maxY - minY, 1), 0.2);
  }

  // Sugiyama has no notion of "keep same-module nodes together", so a
  // module's nodes can end up scattered across the layout and its
  // bounding box can overlap unrelated modules'. Resolve pairwise overlaps
  // by pushing whole modules apart along an axis, moving every node in
  // each module together (a cheap AABB separation pass — modules are few,
  // even if nodes are many).
  //
  // Naively always pushing along the axis of least overlap systematically
  // favors width (module boxes are inherently wider than tall, from text-
  // label padding alone), undoing the earlier axis-swap fix for "too wide,
  // not tall enough". Instead the choice is biased by the CURRENT overall
  // aspect ratio each pass — already wider than tall raises the bar for
  // picking another X-push — which self-corrects toward a balanced result
  // regardless of graph size, rather than needing a fixed magic constant.
  function resolveModuleOverlaps() {
    for (var iter = 0; iter < 400; iter++) {
      var moved = false;
      var aspect = overallAspect();
      for (var i = 0; i < modules.length; i++) {
        for (var j = i + 1; j < modules.length; j++) {
          var a = moduleBounds(modules[i]);
          var b = moduleBounds(modules[j]);
          var overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
          var overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
          if (overlapX <= 0 || overlapY <= 0) continue;

          moved = true;
          var aCx = (a.minX + a.maxX) / 2,
            bCx = (b.minX + b.maxX) / 2;
          var aCy = (a.minY + a.maxY) / 2,
            bCy = (b.minY + b.maxY) / 2;

          if (overlapX * aspect < overlapY) {
            var pushX = overlapX / 2 + CG_PAD_GAP;
            var dir = aCx <= bCx ? -1 : 1;
            translateModule(modules[i], dir * pushX, 0);
            translateModule(modules[j], -dir * pushX, 0);
          } else {
            var pushY = overlapY / 2 + CG_PAD_GAP;
            var dirY = aCy <= bCy ? -1 : 1;
            translateModule(modules[i], 0, dirY * pushY);
            translateModule(modules[j], 0, -dirY * pushY);
          }
        }
      }
      if (!moved) break;
    }
  }
  resolveModuleOverlaps();

  function contentExtent() {
    var minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    modules.forEach(function (mod) {
      var b = moduleBounds(mod);
      if (b.minX < minX) minX = b.minX;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxY > maxY) maxY = b.maxY;
    });
    return { minX: minX, maxX: maxX + 160, minY: minY, maxY: maxY }; // +160 for node label text
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
  var root = zoomLayer
    .append("g")
    .attr("transform", "translate(" + (110 - content.minX) + "," + (70 - content.minY) + ")");

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
    .attr("rx", 12)
    .attr("fill", function (mod) {
      return color(mod);
    })
    .attr("fill-opacity", 0.08)
    .attr("stroke", function (mod) {
      return color(mod);
    })
    .attr("stroke-opacity", 0.45);

  clusters
    .append("text")
    .attr("fill", function (mod) {
      return color(mod);
    })
    .attr("font-size", 11)
    .attr("font-family", "ui-monospace, monospace")
    .style("cursor", "pointer")
    .text(function (mod) {
      return mod + "  (click to collapse)";
    })
    .on("click", function (event, mod) {
      collapsed[mod] = !collapsed[mod];
      applyFilters();
    });

  var collapsed = {};

  function edgePathD(fromId, toId) {
    var a = pos[fromId],
      b = pos[toId];
    if (!a || !b) return "";
    return "M" + a.x + "," + a.y + "L" + b.x + "," + b.y;
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

    clusters.each(function (mod) {
      var b = moduleBounds(mod);
      var g = d3.select(this);
      g.select("rect")
        .attr("x", b.minX)
        .attr("y", b.minY)
        .attr("width", b.maxX - b.minX)
        .attr("height", b.maxY - b.minY);
      g.select("text").attr("x", b.minX + 10).attr("y", b.minY + 16);
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
