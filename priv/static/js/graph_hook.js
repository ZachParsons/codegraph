window.CodegraphHooks = window.CodegraphHooks || {};

function cgNodeId(n) {
  return n.function ? n.module + "." + n.function + "/" + n.arity : n.module;
}

var CG_STATUS_COLOR = {
  added: "#3fb950",
  removed: "#f85149",
  modified: "#d29922",
};

function cgRenderGraph(container, data) {
  container.innerHTML = "";
  if (!data.nodes.length) {
    container.innerHTML =
      '<p style="opacity:0.6; padding: 1rem;">No nodes in scope.</p>';
    return;
  }

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
  var edgeStatusByKey = {};
  data.edges.forEach(function (e) {
    ensureNode(e.from);
    ensureNode(e.to);
    graph.link(cgNodeId(e.from), cgNodeId(e.to));
    edgeStatusByKey[cgNodeId(e.from) + "->" + cgNodeId(e.to)] = e.status;
  });

  var layout = d3.sugiyama().nodeSize(function () {
    return [190, 60];
  });
  var extent = layout(graph);
  var width = Math.max(extent.width + 220, 640);
  var height = Math.max(extent.height + 140, 400);

  var svg = d3
    .select(container)
    .append("svg")
    .attr("width", "100%")
    .attr("viewBox", "0 0 " + width + " " + height)
    .style("background", "#0b0b0f")
    .style("display", "block");

  var root = svg.append("g").attr("transform", "translate(110, 70)");

  var modules = Array.from(
    new Set(
      Array.from(graph.nodes()).map(function (n) {
        return nodesById[n.data].module;
      })
    )
  );
  var color = d3.scaleOrdinal(d3.schemeTableau10).domain(modules);

  var byModule = {};
  for (var node of graph.nodes()) {
    var info = nodesById[node.data];
    (byModule[info.module] = byModule[info.module] || []).push(node);
  }

  var clusterLayer = root.append("g");
  Object.keys(byModule).forEach(function (mod) {
    var pts = byModule[mod];
    var minX = d3.min(pts, function (p) {
        return p.x;
      }) - 70,
      maxX = d3.max(pts, function (p) {
        return p.x;
      }) + 70,
      minY = d3.min(pts, function (p) {
        return p.y;
      }) - 22,
      maxY = d3.max(pts, function (p) {
        return p.y;
      }) + 22;

    clusterLayer
      .append("rect")
      .attr("x", minX)
      .attr("y", minY)
      .attr("width", maxX - minX)
      .attr("height", maxY - minY)
      .attr("rx", 12)
      .attr("fill", color(mod))
      .attr("fill-opacity", 0.08)
      .attr("stroke", color(mod))
      .attr("stroke-opacity", 0.45);

    clusterLayer
      .append("text")
      .attr("x", minX + 10)
      .attr("y", minY + 16)
      .attr("fill", color(mod))
      .attr("font-size", 11)
      .attr("font-family", "ui-monospace, monospace")
      .text(mod);
  });

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

  var line = d3
    .line()
    .x(function (d) {
      return d.x;
    })
    .y(function (d) {
      return d.y;
    })
    .curve(d3.curveMonotoneY);

  function edgeStatus(d) {
    return edgeStatusByKey[d.source.data + "->" + d.target.data];
  }

  root
    .append("g")
    .selectAll("path")
    .data(Array.from(graph.links()))
    .join("path")
    .attr("d", function (d) {
      return line(d.points);
    })
    .attr("fill", "none")
    .attr("stroke", function (d) {
      return CG_STATUS_COLOR[edgeStatus(d)] || "#8a8a92";
    })
    .attr("stroke-width", function (d) {
      return edgeStatus(d) in CG_STATUS_COLOR ? 2 : 1.4;
    })
    .attr("stroke-dasharray", function (d) {
      return edgeStatus(d) === "removed" ? "4,3" : null;
    })
    .attr("marker-end", "url(#cg-arrow)");

  var nodeG = root
    .append("g")
    .selectAll("g")
    .data(Array.from(graph.nodes()))
    .join("g")
    .attr("transform", function (d) {
      return "translate(" + d.x + "," + d.y + ")";
    });

  nodeG
    .append("circle")
    .attr("r", function (d) {
      return CG_STATUS_COLOR[nodesById[d.data].status] ? 8 : 7;
    })
    .attr("fill", function (d) {
      var info = nodesById[d.data];
      if (info.external) return "#3a3a3f";
      return CG_STATUS_COLOR[info.status] || color(info.module);
    })
    .attr("stroke", function (d) {
      var info = nodesById[d.data];
      if (info.external) return "#777";
      return CG_STATUS_COLOR[info.status] || "#fff";
    })
    .attr("stroke-width", function (d) {
      return CG_STATUS_COLOR[nodesById[d.data].status] ? 2 : 1.3;
    })
    .attr("stroke-dasharray", function (d) {
      return nodesById[d.data].status === "removed" ? "3,2" : null;
    })
    .attr("opacity", function (d) {
      return nodesById[d.data].external ? 0.55 : 1;
    });

  nodeG
    .append("text")
    .attr("x", 11)
    .attr("y", 4)
    .attr("font-family", "ui-monospace, monospace")
    .attr("font-size", 11)
    .attr("fill", function (d) {
      var info = nodesById[d.data];
      if (info.external) return "#8a8a92";
      return CG_STATUS_COLOR[info.status] || "#eee";
    })
    .text(function (d) {
      var info = nodesById[d.data];
      return info.function + "/" + info.arity;
    });

  nodeG.append("title").text(function (d) {
    return d.data;
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
