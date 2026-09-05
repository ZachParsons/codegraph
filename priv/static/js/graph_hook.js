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
    '<label style="display:flex; align-items:center; gap:4px; font-size:11px; opacity:0.8; cursor:pointer;">' +
    '<input type="checkbox" id="cg-stdlib-toggle">hide stdlib</label>' +
    '<span style="opacity:0.5; font-size:11px;">scroll/two-finger swipe to pan, pinch to zoom · click a node to highlight its callers/calls · drag a node, or a module\'s label to move all its nodes · shift+drag to select an area, shift or ctrl/cmd+click to select one at a time, esc to clear · click a label to collapse</span>';
  container.appendChild(toolbar);
  var searchInput = toolbar.querySelector("input");
  var moduleLabelToggle = toolbar.querySelector("#cg-module-label-toggle");
  moduleLabelToggle.checked = cgShowModuleLabels;
  var stdlibToggle = toolbar.querySelector("#cg-stdlib-toggle");
  stdlibToggle.checked = cgHideStdlib;

  // Node positions and module "box" groupings — pure layout math, no DOM
  // involved — come from graph_layout.js. Destructured into the same
  // local names the rendering code below has always used, so nothing
  // past this point needed to change when the layout algorithm moved out
  // to its own file.
  var L = cgComputeLayout(data);
  var nodesById = L.nodesById;
  var callerOnlyIds = L.callerOnlyIds;
  var edgeList = L.edgeList;
  var callerEdgeList = L.callerEdgeList;
  var pos = L.pos;
  var boxOf = L.boxOf;
  var boxMembers = L.boxMembers;
  var boxIds = L.boxIds;
  var boxModule = L.boxModule;
  var isCallerBox = L.isCallerBox;
  var color = L.color;

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

  // A fixed per-level pixel gap either wastes the viewport (few levels) or
  // stays cramped (many levels) depending on the graph — see fitScale
  // below, which uses this to fit the drawn content to the actual window
  // rather than a fixed guess.
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

  // Edge objects (not just node ids) reachable from the focused node —
  // membership is by object identity, which works because edgePaths'/
  // edgeArrows' own data (edgeList.concat(callerEdgeList)) is these exact
  // same objects. Declared here (not down by updateFocusHighlight, which
  // repopulates them) so edgeStrokeColor/edgeStrokeWidth below can be the
  // SAME functions used for both the initial render and every later
  // focus-highlight update — referencing them before any focus exists is
  // safe (both start empty, so every `.has(e)` below is simply false).
  var outgoingEdgeSet = new Set();
  var incomingEdgeSet = new Set();

  function edgeStrokeColor(e) {
    if (outgoingEdgeSet.has(e)) return CG_OUTGOING_EDGE_COLOR;
    if (incomingEdgeSet.has(e)) return CG_INCOMING_EDGE_COLOR;
    if (e.kind === "caller") return CG_CALLER_EDGE_COLOR;
    return CG_STATUS_COLOR[e.status] || "#8a8a92";
  }

  function edgeStrokeWidth(e) {
    if (outgoingEdgeSet.has(e) || incomingEdgeSet.has(e)) return 2.5;
    return e.status in CG_STATUS_COLOR ? 2 : 1.4;
  }

  // `focusedId` isn't declared until further below (harmless — it's a
  // plain var, so it's just `undefined`, same as falsy `null`, until
  // then), which is why this can already be used for the initial render.
  function edgeOpacity(e) {
    if (!focusedId) return e.kind === "caller" ? 0.6 : 1;
    return outgoingEdgeSet.has(e) || incomingEdgeSet.has(e) ? 1 : CG_DIM_OPACITY;
  }

  // Every edge is TWO shapes, not one path-with-marker-end: a line and an
  // explicitly computed arrowhead triangle. An SVG <marker>'s own
  // refX/markerUnits/viewBox scaling proved to be a persistent, hard-to-
  // reason-about source of the arrow's tip landing somewhere other than
  // exactly where the line was trimmed to — computing the triangle
  // ourselves, from the same direction vector and stroke-width already
  // driving the line, removes that indirection entirely: the tip is
  // placed exactly on the target's boundary (touching it, not stopping
  // short), and the line's own endpoint is exactly the arrow's back-
  // center, so the two shapes meet with neither a gap nor an overlap.
  //
  // The source end still stops a hair short of ITS node's boundary (the
  // "+ 1") — there's no arrowhead there to butt up against, so this just
  // keeps the line from visibly running into that node's own stroke ring.
  function edgeGeometry(fromId, toId, strokeWidth) {
    var a = pos[fromId],
      b = pos[toId];
    if (!a || !b) return null;
    var dx = b.x - a.x,
      dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / dist,
      uy = dy / dist;
    var px = -uy,
      py = ux;
    var ra = cgNodeBoundaryDist(fromId, ux, uy) + 1;
    var sx = a.x + ux * ra,
      sy = a.y + uy * ra;
    var tipX = b.x - ux * cgNodeBoundaryDist(toId, ux, uy),
      tipY = b.y - uy * cgNodeBoundaryDist(toId, ux, uy);
    var arrowLen = 6 * strokeWidth,
      halfWidth = 3 * strokeWidth;
    var backX = tipX - ux * arrowLen,
      backY = tipY - uy * arrowLen;
    return {
      sx: sx,
      sy: sy,
      backX: backX,
      backY: backY,
      tipX: tipX,
      tipY: tipY,
      leftX: backX + px * halfWidth,
      leftY: backY + py * halfWidth,
      rightX: backX - px * halfWidth,
      rightY: backY - py * halfWidth,
    };
  }

  function edgeLineD(e) {
    var g = edgeGeometry(e.fromId, e.toId, edgeStrokeWidth(e));
    return g ? "M" + g.sx + "," + g.sy + "L" + g.backX + "," + g.backY : "";
  }

  function edgeArrowD(e) {
    var g = edgeGeometry(e.fromId, e.toId, edgeStrokeWidth(e));
    return g ? "M" + g.tipX + "," + g.tipY + "L" + g.leftX + "," + g.leftY + "L" + g.rightX + "," + g.rightY + "Z" : "";
  }

  var edgePaths = edgeLayer
    .selectAll("path.cg-edge-line")
    .data(edgeList.concat(callerEdgeList))
    .join("path")
    .attr("class", "cg-edge-line")
    .attr("fill", "none")
    .attr("stroke", edgeStrokeColor)
    .attr("stroke-width", edgeStrokeWidth)
    .attr("stroke-dasharray", function (e) {
      return e.status === "removed" ? "4,3" : null;
    })
    .attr("opacity", edgeOpacity);

  var edgeArrows = edgeLayer
    .selectAll("path.cg-edge-arrow")
    .data(edgeList.concat(callerEdgeList))
    .join("path")
    .attr("class", "cg-edge-arrow")
    .attr("stroke", "none")
    .attr("fill", edgeStrokeColor)
    .attr("opacity", edgeOpacity);

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
  // boundary instead of the center (see edgeGeometry below). A circle's
  // boundary is the same distance in every direction; the diamond is a
  // true rotated square (see cgSymbolSquareDiamond just above), whose
  // |x| + |y| = r boundary sits at r / (|ux| + |uy|) along a unit
  // direction — the standard L1-ball distance formula. edgeGeometry
  // passes the same (ux, uy) for both the source and target node, which
  // is only valid because both shapes are centrally symmetric: the
  // boundary distance along a line is identical measured from either end.
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

  // outgoingEdgeSet/incomingEdgeSet (used by edgeStrokeColor/edgeStrokeWidth/
  // edgeOpacity above) are repopulated here from `focusedId` each time it
  // changes; connectedOutIds/connectedInIds are the same idea for nodeStroke/
  // nodeOpacity.
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

    // Both shapes' geometry is recomputed too, not just color/opacity —
    // a focused edge's stroke-width changes (see edgeStrokeWidth), and
    // the arrowhead's size (and thus the line's own endpoint, its back-
    // center) is derived from that same stroke-width.
    edgePaths.attr("d", edgeLineD).attr("stroke", edgeStrokeColor).attr("stroke-width", edgeStrokeWidth).attr("opacity", edgeOpacity);
    edgeArrows.attr("d", edgeArrowD).attr("fill", edgeStrokeColor).attr("opacity", edgeOpacity);

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

    edgePaths.attr("d", edgeLineD);
    edgeArrows.attr("d", edgeArrowD);

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

  function isHiddenStdlib(id) {
    return cgHideStdlib && !!(nodesById[id] && nodesById[id].stdlib);
  }

  function applyFilters() {
    var query = (searchInput.value || "").toLowerCase();

    nodeG.style("display", function (id) {
      if (collapsed[boxOf[id]]) return "none";
      if (isHiddenStdlib(id)) return "none";
      if (query && id.toLowerCase().indexOf(query) === -1) return "none";
      return null;
    });

    // The arrowhead is a separate shape from the line now (see
    // edgeGeometry above), not a marker-end riding along on the line's
    // own element — both need this same display toggle, or a hidden
    // edge's line disappears while its arrowhead is left floating with
    // nothing attached to it.
    function edgeHidden(e) {
      return !!(
        collapsed[boxOf[e.fromId]] ||
        collapsed[boxOf[e.toId]] ||
        isHiddenStdlib(e.fromId) ||
        isHiddenStdlib(e.toId) ||
        (query && e.fromId.toLowerCase().indexOf(query) === -1 && e.toId.toLowerCase().indexOf(query) === -1)
      );
    }

    edgePaths.style("display", function (e) {
      return edgeHidden(e) ? "none" : null;
    });
    edgeArrows.style("display", function (e) {
      return edgeHidden(e) ? "none" : null;
    });

    clusters.style("opacity", function (id) {
      var base = isCallerBox(id) ? 0.5 : 1;
      return collapsed[id] ? 0.35 * base : base;
    });

    // A stdlib module (Enum, Keyword, ...) gets one box shared by every
    // call to it (see boxOf assignment above) — once every member of
    // that box is hidden by the toggle, hide the now-empty box shell
    // too rather than leaving a floating labeled rectangle with nothing
    // in it.
    clusters.style("display", function (id) {
      return boxMembers[id].every(isHiddenStdlib) ? "none" : null;
    });
  }

  searchInput.addEventListener("input", applyFilters);

  moduleLabelToggle.addEventListener("change", function () {
    cgShowModuleLabels = moduleLabelToggle.checked;
    nodeG.selectAll(".cg-module-label").style("display", cgShowModuleLabels ? null : "none");
  });

  stdlibToggle.addEventListener("change", function () {
    cgHideStdlib = stdlibToggle.checked;
    applyFilters();
  });

  // Applies cgHideStdlib's default (and any collapsed/search state
  // already carried over from cgShowModuleLabels-style module-scope
  // persistence) as soon as the graph is built, rather than only after
  // the first toolbar interaction.
  applyFilters();
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
