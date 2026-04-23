import { geoGraticule10, geoOrthographic, geoPath } from "https://cdn.jsdelivr.net/npm/d3-geo@3/+esm";
import { feature } from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";

const root = document.getElementById("globe-root");
const mapStage = document.getElementById("map-stage");
const globeViewBtn = document.getElementById("view-globe-btn");
const localViewBtn = document.getElementById("view-local-btn");
const helmPanel = document.getElementById("helm-panel");
const helmToggleBtn = document.getElementById("helm-toggle");
const globeView = document.getElementById("globe-root");
const localViewCanvas = document.getElementById("local-map");
const statHeading = document.getElementById("stat-heading");
const statSpeed = document.getElementById("stat-speed");
const statAppWind = document.getElementById("stat-app-wind");
const statEta = document.getElementById("stat-eta");

const steerModeSelect = document.getElementById("steer-mode");
const courseInput = document.getElementById("course");
const courseReadout = document.getElementById("course-readout");
const windAngleInput = document.getElementById("wind-angle");
const windAngleReadout = document.getElementById("wind-angle-readout");
const mainTrimInput = document.getElementById("main-trim");
const mainReadout = document.getElementById("main-readout");
const jibTrimInput = document.getElementById("jib-trim");
const jibReadout = document.getElementById("jib-readout");
const reefLevelSelect = document.getElementById("reef-level");
const safetyModeSelect = document.getElementById("safety-mode");
const vaneCanvas = document.getElementById("wind-vane");
const vaneCtx = vaneCanvas.getContext("2d");
const localCanvas = localViewCanvas;
const localCtx = localCanvas.getContext("2d");
const localZoomInput = document.getElementById("local-zoom");
const localZoomReadout = document.getElementById("local-zoom-readout");
const wxWind = document.getElementById("wx-wind");
const wxCurrent = document.getElementById("wx-current");
const wxSea = document.getElementById("wx-sea");

const globeCanvas = document.createElement("canvas");
const globeCtx = globeCanvas.getContext("2d");
root.appendChild(globeCanvas);

const view = {
  rotY: 0,
  tilt: -0.3,
  scale: 1,
  dragging: false,
  dragX: 0,
  dragY: 0,
};
let activeMapView = "globe";

const FLICKA_20 = {
  hullSpeed: 5.95,
  noGoAngle: 42,
  displacementPenalty: 0.92,
  polarSamples: [
    { angle: 45, ratio: 0.52 },
    { angle: 60, ratio: 0.66 },
    { angle: 75, ratio: 0.76 },
    { angle: 90, ratio: 0.84 },
    { angle: 110, ratio: 0.9 },
    { angle: 130, ratio: 0.94 },
    { angle: 150, ratio: 0.88 },
    { angle: 170, ratio: 0.72 },
  ],
  reefMultipliers: { 0: 1, 1: 0.86, 2: 0.71, 3: 0.52 },
};

const state = {
  lat: 51.1,
  lon: -8.2,
  heading: 241,
  targetHeading: 241,
  steerMode: "heading",
  targetWindAngle: 118,
  trueWindDir: 307,
  trueWindSpeed: 18.4,
  mainTrim: 82,
  jibTrim: 76,
  reefLevel: 1,
  safetyMode: "normal",
  sog: 0,
  lastTick: performance.now(),
};

const trailPoints = [];
let landGeometry = null;
const localView = {
  radiusKm: 0.35,
  currentSpeed: 0,
  currentDir: 0,
};

setupControls();
updateStatPanel(0);
drawWindVane();
setupGlobeInteraction();
setupLayoutControls();
resizeCanvas();
loadLandGeometry();

window.addEventListener("resize", () => {
  resizeCanvas();
});

animate();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const deltaSec = Math.min((now - state.lastTick) / 1000, 0.5);
  state.lastTick = now;

  runSimulationStep(deltaSec);
  drawGlobe();
  drawLocalMap();
}

function setupControls() {
  steerModeSelect.addEventListener("change", () => {
    state.steerMode = steerModeSelect.value;
  });
  courseInput.addEventListener("input", () => {
    state.targetHeading = Number(courseInput.value);
    courseReadout.textContent = `${Math.round(state.targetHeading)}°`;
  });
  windAngleInput.addEventListener("input", () => {
    state.targetWindAngle = Number(windAngleInput.value);
    windAngleReadout.textContent = `${Math.round(state.targetWindAngle)}°`;
  });
  mainTrimInput.addEventListener("input", () => {
    state.mainTrim = Number(mainTrimInput.value);
    mainReadout.textContent = `${Math.round(state.mainTrim)}%`;
  });
  jibTrimInput.addEventListener("input", () => {
    state.jibTrim = Number(jibTrimInput.value);
    jibReadout.textContent = `${Math.round(state.jibTrim)}%`;
  });
  reefLevelSelect.addEventListener("change", () => {
    state.reefLevel = Number(reefLevelSelect.value);
  });
  safetyModeSelect.addEventListener("change", () => {
    state.safetyMode = safetyModeSelect.value;
  });
  localZoomInput.addEventListener("input", () => {
    localView.radiusKm = Number(localZoomInput.value) / 1000;
    localZoomReadout.textContent = `${localView.radiusKm.toFixed(2)} km`;
  });
}

function setupLayoutControls() {
  globeViewBtn.addEventListener("click", () => {
    activeMapView = "globe";
    globeView.classList.add("active");
    localViewCanvas.classList.remove("active");
    globeViewBtn.classList.add("active");
    localViewBtn.classList.remove("active");
    resizeCanvas();
  });
  localViewBtn.addEventListener("click", () => {
    activeMapView = "local";
    localViewCanvas.classList.add("active");
    globeView.classList.remove("active");
    localViewBtn.classList.add("active");
    globeViewBtn.classList.remove("active");
    resizeCanvas();
  });
  helmToggleBtn.addEventListener("click", () => {
    helmPanel.classList.toggle("closed");
  });
}

function runSimulationStep(deltaSec) {
  const wind = windAt(state.lat, state.lon);
  state.trueWindDir = wind.direction;
  state.trueWindSpeed = wind.speed;
  const current = currentAt(state.lat, state.lon);
  localView.currentSpeed = current.speed;
  localView.currentDir = current.direction;

  if (state.steerMode === "heading") {
    state.heading = moveTowardAngle(state.heading, state.targetHeading, deltaSec * 12);
  } else {
    const preferredPort = normalizeAngle(state.trueWindDir + state.targetWindAngle);
    const preferredStarboard = normalizeAngle(state.trueWindDir - state.targetWindAngle);
    const currentToPort = angleDelta(state.heading, preferredPort);
    const currentToStar = angleDelta(state.heading, preferredStarboard);
    const target = Math.abs(currentToPort) <= Math.abs(currentToStar) ? preferredPort : preferredStarboard;
    state.heading = moveTowardAngle(state.heading, target, deltaSec * 10);
  }

  const twa = absoluteWindAngle(state.heading, state.trueWindDir);
  const sailArea = (state.mainTrim * 0.55 + state.jibTrim * 0.45) / 100;
  const reefFactor = FLICKA_20.reefMultipliers[state.reefLevel];
  const heelLimit = safetyHeelCap(state.safetyMode);
  const heel = estimateHeel(twa, state.trueWindSpeed, sailArea, reefFactor);
  const heelPenalty = heel > heelLimit ? Math.max(0.55, 1 - (heel - heelLimit) * 0.0175) : 1;

  const polarRatio = interpolatePolar(twa, FLICKA_20.polarSamples);
  const breezeFactor = Math.min(1.1, Math.max(0.22, state.trueWindSpeed / 20));
  const noGoPenalty = twa < FLICKA_20.noGoAngle ? Math.max(0, (twa - 30) / (FLICKA_20.noGoAngle - 30)) : 1;

  state.sog =
    FLICKA_20.hullSpeed *
    polarRatio *
    breezeFactor *
    sailArea *
    reefFactor *
    heelPenalty *
    noGoPenalty *
    FLICKA_20.displacementPenalty;
  state.sog = Math.max(0, Math.min(FLICKA_20.hullSpeed, state.sog));

  const miles = state.sog * (deltaSec / 3600);
  moveBoatAlongHeading(miles, state.heading);
  pushTrailPoint();

  const appWind = estimateApparentWind(twa, state.trueWindSpeed, state.sog);
  updateStatPanel(appWind.angle);
  updateWeatherStrip();
  drawWindVane();
}

function updateStatPanel(apparentAngle) {
  statHeading.textContent = `${Math.round(state.heading)}°`;
  statSpeed.textContent = `${state.sog.toFixed(1)} kn`;
  statAppWind.textContent = `${Math.round(apparentAngle)}°`;
  statEta.textContent = estimateAtlanticEta(state.sog);
}

function estimateAtlanticEta(knots) {
  const nm = 2800;
  const safeKnots = Math.max(2.6, knots);
  const days = nm / safeKnots / 24;
  const whole = Math.floor(days);
  const hours = Math.round((days - whole) * 24);
  return `${whole}d ${hours}h`;
}

function pushTrailPoint() {
  trailPoints.push({ lat: state.lat, lon: state.lon });
  if (trailPoints.length > 500) {
    trailPoints.shift();
  }
}

function moveBoatAlongHeading(nauticalMiles, headingDeg) {
  const earthRadiusNm = 3440.065;
  const d = nauticalMiles / earthRadiusNm;
  const brng = degToRad(headingDeg);
  const lat1 = degToRad(state.lat);
  const lon1 = degToRad(state.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  state.lat = radToDeg(lat2);
  state.lon = normalizeLon(radToDeg(lon2));
}

function windAt(lat, lon) {
  // Trade-wind band + westerlies approximation for early prototype behavior.
  const absLat = Math.abs(lat);
  let direction = 0;
  let speed = 12;
  if (absLat <= 25) {
    direction = lat >= 0 ? 45 : 135;
    speed = 14 + Math.max(0, 25 - absLat) * 0.13;
  } else if (absLat <= 55) {
    direction = lat >= 0 ? 255 : 285;
    speed = 17 + Math.max(0, absLat - 25) * 0.1;
  } else {
    direction = lat >= 0 ? 280 : 250;
    speed = 20;
  }
  const variability = Math.sin((lon / 180) * Math.PI * 3) * 2.2 + Math.cos((lat / 90) * Math.PI) * 1.4;
  return {
    direction: normalizeAngle(direction + variability * 3),
    speed: Math.max(6, speed + variability),
  };
}

function currentAt(lat, lon) {
  const speed = 0.5 + Math.max(0, Math.sin((lat / 90) * Math.PI)) * 0.6;
  const direction = normalizeAngle(250 + Math.sin((lon / 180) * Math.PI * 2) * 24);
  return { speed, direction };
}

function interpolatePolar(angle, samples) {
  if (angle <= samples[0].angle) return samples[0].ratio;
  if (angle >= samples[samples.length - 1].angle) return samples[samples.length - 1].ratio;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (angle >= a.angle && angle <= b.angle) {
      const t = (angle - a.angle) / (b.angle - a.angle);
      return a.ratio + (b.ratio - a.ratio) * t;
    }
  }
  return 0.65;
}

function absoluteWindAngle(heading, windDir) {
  return Math.abs(angleDelta(heading, windDir));
}

function estimateApparentWind(twa, tws, boatSpeed) {
  const twaRad = degToRad(twa);
  const awX = tws * Math.cos(twaRad) - boatSpeed;
  const awY = tws * Math.sin(twaRad);
  const angle = Math.abs(radToDeg(Math.atan2(awY, awX)));
  return { angle, speed: Math.sqrt(awX * awX + awY * awY) };
}

function estimateHeel(twa, tws, sailArea, reefFactor) {
  const drivingAngle = Math.max(0.28, Math.sin(degToRad(twa)));
  return tws * sailArea * reefFactor * drivingAngle * 1.05;
}

function safetyHeelCap(mode) {
  if (mode === "conservative") return 15;
  if (mode === "push") return 24;
  return 20;
}

function drawWindVane() {
  const w = vaneCanvas.width;
  const h = vaneCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = 95;

  vaneCtx.clearRect(0, 0, w, h);
  vaneCtx.strokeStyle = "#1c355a";
  vaneCtx.lineWidth = 1;
  vaneCtx.beginPath();
  vaneCtx.arc(cx, cy, r, 0, Math.PI * 2);
  vaneCtx.stroke();

  vaneCtx.strokeStyle = "#162a45";
  vaneCtx.beginPath();
  vaneCtx.arc(cx, cy, r * 0.66, 0, Math.PI * 2);
  vaneCtx.stroke();

  drawNeedle(state.heading, "#71c8ff", r - 5, 3);
  drawNeedle(state.trueWindDir, "#ffb16d", r - 10, 3);
  const targetDir = state.steerMode === "heading" ? state.targetHeading : normalizeAngle(state.trueWindDir + state.targetWindAngle);
  drawNeedle(targetDir, "#77fca9", r - 18, 2);

  vaneCtx.fillStyle = "#7f97be";
  vaneCtx.font = "11px Segoe UI";
  vaneCtx.textAlign = "center";
  vaneCtx.fillText("N", cx, cy - r - 6);
  vaneCtx.fillText("S", cx, cy + r + 14);
  vaneCtx.fillText("W", cx - r - 8, cy + 4);
  vaneCtx.fillText("E", cx + r + 8, cy + 4);

  function drawNeedle(deg, color, len, width) {
    const rad = degToRad(deg - 90);
    vaneCtx.strokeStyle = color;
    vaneCtx.lineWidth = width;
    vaneCtx.beginPath();
    vaneCtx.moveTo(cx, cy);
    vaneCtx.lineTo(cx + Math.cos(rad) * len, cy + Math.sin(rad) * len);
    vaneCtx.stroke();
  }
}

function moveTowardAngle(current, target, step) {
  const delta = angleDelta(current, target);
  if (Math.abs(delta) <= step) return normalizeAngle(target);
  return normalizeAngle(current + Math.sign(delta) * step);
}

function angleDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

function normalizeAngle(deg) {
  return ((deg % 360) + 360) % 360;
}

function normalizeLon(lon) {
  let value = lon;
  while (value < -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

function resizeCanvas() {
  globeCanvas.width = mapStage.clientWidth;
  globeCanvas.height = mapStage.clientHeight;
  localCanvas.width = Math.max(300, localCanvas.clientWidth * window.devicePixelRatio);
  localCanvas.height = Math.max(160, localCanvas.clientHeight * window.devicePixelRatio);
  localCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function setupGlobeInteraction() {
  globeCanvas.addEventListener("mousedown", (event) => {
    view.dragging = true;
    view.dragX = event.clientX;
    view.dragY = event.clientY;
  });
  window.addEventListener("mouseup", () => {
    view.dragging = false;
  });
  window.addEventListener("mousemove", (event) => {
    if (!view.dragging) return;
    const dx = event.clientX - view.dragX;
    const dy = event.clientY - view.dragY;
    view.dragX = event.clientX;
    view.dragY = event.clientY;
    view.rotY += dx * 0.005;
    view.tilt = Math.max(-1.2, Math.min(1.2, view.tilt + dy * 0.003));
  });
  globeCanvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.scale = Math.max(0.7, Math.min(4.2, view.scale + (event.deltaY > 0 ? -0.12 : 0.12)));
  });
}

function drawGlobe() {
  if (activeMapView !== "globe") return;
  const w = globeCanvas.width;
  const h = globeCanvas.height;
  const cx = w * 0.5;
  const cy = h * 0.53;
  const radius = Math.min(w, h) * 0.34 * view.scale;
  const projection = geoOrthographic()
    .translate([cx, cy])
    .scale(radius)
    .rotate([radToDeg(-view.rotY), radToDeg(-view.tilt), 0])
    .clipAngle(90);
  const path = geoPath(projection, globeCtx);

  globeCtx.clearRect(0, 0, w, h);
  const bg = globeCtx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, radius * 0.2, cx, cy, radius * 1.25);
  bg.addColorStop(0, "#112543");
  bg.addColorStop(1, "#071325");
  globeCtx.fillStyle = bg;
  globeCtx.beginPath();
  globeCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  globeCtx.fill();

  drawGrid(path);
  drawLand(path);
  drawTrail(projection);
  drawPredictionLine(projection);
  drawBoatIcon(projection, state.lat, state.lon, state.heading, "#ffaf66", 13);

  globeCtx.strokeStyle = "#4c78a8";
  globeCtx.globalAlpha = 0.75;
  globeCtx.lineWidth = 1.1;
  globeCtx.beginPath();
  globeCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  globeCtx.stroke();
  globeCtx.globalAlpha = 1;
}

function drawGrid(path) {
  const graticule = geoGraticule10();
  globeCtx.strokeStyle = "rgba(86, 132, 185, 0.32)";
  globeCtx.lineWidth = 1;
  globeCtx.beginPath();
  path(graticule);
  globeCtx.stroke();
}

function drawLand(path) {
  if (!landGeometry) return;
  globeCtx.fillStyle = "rgba(128, 149, 170, 0.92)";
  globeCtx.strokeStyle = "rgba(195, 214, 232, 0.76)";
  globeCtx.lineWidth = 0.75;
  globeCtx.beginPath();
  path(landGeometry);
  globeCtx.fill();
  globeCtx.stroke();
}

function drawTrail(projection) {
  if (trailPoints.length < 2) return;
  globeCtx.strokeStyle = "rgba(255, 175, 102, 0.8)";
  globeCtx.lineWidth = 1.2;
  globeCtx.beginPath();
  let hasStarted = false;
  for (const point of trailPoints) {
    const p = projection([point.lon, point.lat]);
    if (!p) {
      hasStarted = false;
      continue;
    }
    if (!hasStarted) {
      globeCtx.moveTo(p[0], p[1]);
      hasStarted = true;
    } else {
      globeCtx.lineTo(p[0], p[1]);
    }
  }
  globeCtx.stroke();
}

function drawBoatIcon(projection, lat, lon, heading, color, size) {
  const p = projection([lon, lat]);
  if (!p) return;
  const nose = projectionPointAhead(projection, lat, lon, heading, 0.5);
  if (!nose) return;
  const ctx = globeCtx;
  const angle = Math.atan2(nose[1] - p[1], nose[0] - p[0]);
  ctx.save();
  ctx.translate(p[0], p[1]);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.strokeStyle = "#001226";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.65, size * 0.46);
  ctx.lineTo(-size * 0.65, -size * 0.46);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(-size * 0.6, -size * 0.18, size * 0.56, size * 0.36);
  ctx.restore();
}

function drawPredictionLine(projection) {
  if (state.sog <= 0.05) return;
  // 1-hour prediction assuming current wind/trim/heading stay unchanged.
  const next = destinationPoint(state.lat, state.lon, state.heading, state.sog);
  const start = projection([state.lon, state.lat]);
  const end = projection([next.lon, next.lat]);
  if (!start || !end) return;

  globeCtx.setLineDash([7, 6]);
  globeCtx.strokeStyle = "rgba(113, 200, 255, 0.95)";
  globeCtx.lineWidth = 1.5;
  globeCtx.beginPath();
  globeCtx.moveTo(start[0], start[1]);
  globeCtx.lineTo(end[0], end[1]);
  globeCtx.stroke();
  globeCtx.setLineDash([]);

  globeCtx.fillStyle = "#71c8ff";
  globeCtx.beginPath();
  globeCtx.arc(end[0], end[1], 3, 0, Math.PI * 2);
  globeCtx.fill();
}

function drawLocalMap() {
  if (activeMapView !== "local") return;
  const w = localCanvas.clientWidth;
  const h = localCanvas.clientHeight;
  localCtx.clearRect(0, 0, w, h);

  localCtx.fillStyle = "#091326";
  localCtx.fillRect(0, 0, w, h);
  drawLocalGrid(w, h);

  const centerX = w * 0.5;
  const centerY = h * 0.5;
  drawWindArrow(localCtx, centerX + 120, centerY - 76, state.trueWindDir, "#ffb16d", "Wind");
  drawWindArrow(localCtx, centerX + 120, centerY - 34, localView.currentDir, "#77fca9", "Current");

  drawLocalPrediction(centerX, centerY);
  drawLocalBoat(centerX, centerY, state.heading);

  localCtx.fillStyle = "#7f97be";
  localCtx.font = "11px Segoe UI";
  localCtx.fillText(`Radius: ${(localView.radiusKm * 1000).toFixed(0)} m`, 10, h - 12);
}

function drawLocalGrid(w, h) {
  localCtx.strokeStyle = "rgba(63, 96, 141, 0.35)";
  localCtx.lineWidth = 1;
  const step = 32;
  for (let x = 0; x < w; x += step) {
    localCtx.beginPath();
    localCtx.moveTo(x, 0);
    localCtx.lineTo(x, h);
    localCtx.stroke();
  }
  for (let y = 0; y < h; y += step) {
    localCtx.beginPath();
    localCtx.moveTo(0, y);
    localCtx.lineTo(w, y);
    localCtx.stroke();
  }
}

function drawLocalBoat(x, y, heading) {
  const size = 15;
  localCtx.save();
  localCtx.translate(x, y);
  localCtx.rotate(degToRad(heading - 90));
  localCtx.fillStyle = "#ffaf66";
  localCtx.strokeStyle = "#001226";
  localCtx.lineWidth = 1.2;
  localCtx.beginPath();
  localCtx.moveTo(size, 0);
  localCtx.lineTo(-size * 0.65, size * 0.48);
  localCtx.lineTo(-size * 0.65, -size * 0.48);
  localCtx.closePath();
  localCtx.fill();
  localCtx.stroke();
  localCtx.fillStyle = "rgba(255,255,255,0.84)";
  localCtx.fillRect(-size * 0.56, -size * 0.18, size * 0.52, size * 0.36);
  localCtx.restore();
}

function drawLocalPrediction(centerX, centerY) {
  const safeRadiusKm = Math.max(0.001, localView.radiusKm);
  const distanceKm = (state.sog * 1.852) * 1; // 1 hour prediction.
  const pxPerKm = (Math.min(localCanvas.clientWidth, localCanvas.clientHeight) * 0.4) / safeRadiusKm;
  const travelPx = Math.min(distanceKm * pxPerKm, Math.min(localCanvas.clientWidth, localCanvas.clientHeight) * 0.45);
  const angle = degToRad(state.heading - 90);
  const x2 = centerX + Math.cos(angle) * travelPx;
  const y2 = centerY + Math.sin(angle) * travelPx;

  localCtx.setLineDash([7, 6]);
  localCtx.strokeStyle = "rgba(113, 200, 255, 0.95)";
  localCtx.lineWidth = 1.5;
  localCtx.beginPath();
  localCtx.moveTo(centerX, centerY);
  localCtx.lineTo(x2, y2);
  localCtx.stroke();
  localCtx.setLineDash([]);

  localCtx.fillStyle = "#71c8ff";
  localCtx.beginPath();
  localCtx.arc(x2, y2, 3, 0, Math.PI * 2);
  localCtx.fill();
}

function drawWindArrow(ctx, x, y, dirDeg, color, label) {
  const len = 24;
  const rad = degToRad(dirDeg - 90);
  const x2 = x + Math.cos(rad) * len;
  const y2 = y + Math.sin(rad) * len;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(rad - 0.45) * 7, y2 - Math.sin(rad - 0.45) * 7);
  ctx.lineTo(x2 - Math.cos(rad + 0.45) * 7, y2 - Math.sin(rad + 0.45) * 7);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#9eb4d5";
  ctx.font = "10px Segoe UI";
  ctx.fillText(label, x + 30, y + 4);
}

function updateWeatherStrip() {
  wxWind.textContent = `${Math.round(state.trueWindDir)}° ${state.trueWindSpeed.toFixed(1)} kn`;
  wxCurrent.textContent = `${Math.round(localView.currentDir)}° ${localView.currentSpeed.toFixed(1)} kn`;
  const seaLevel = state.trueWindSpeed >= 22 ? "Rough" : state.trueWindSpeed >= 15 ? "Moderate" : "Calm";
  wxSea.textContent = seaLevel;
}

function projectionPointAhead(projection, lat, lon, headingDeg, nm) {
  const ahead = destinationPoint(lat, lon, headingDeg, nm);
  return projection([ahead.lon, ahead.lat]);
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function destinationPoint(lat, lon, headingDeg, nauticalMiles) {
  const earthRadiusNm = 3440.065;
  const d = nauticalMiles / earthRadiusNm;
  const brng = degToRad(headingDeg);
  const lat1 = degToRad(lat);
  const lon1 = degToRad(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    lat: radToDeg(lat2),
    lon: normalizeLon(radToDeg(lon2)),
  };
}

async function loadLandGeometry() {
  try {
    const response = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json");
    const topo = await response.json();
    landGeometry = feature(topo, topo.objects.land);
  } catch (_err) {
    landGeometry = null;
  }
}
