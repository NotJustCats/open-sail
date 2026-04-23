const root = document.getElementById("globe-root");
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

const otherBoats = [
  { lat: 37.8, lon: -28.3, color: "#71c8ff" },
  { lat: 14.6, lon: -56.2, color: "#77fca9" },
  { lat: 26.1, lon: -38.2, color: "#d98eff" },
];
const trailPoints = [];

setupControls();
updateStatPanel(0);
drawWindVane();
setupGlobeInteraction();
resizeCanvas();

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
  view.rotY += 0.0007;
  drawGlobe();
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
}

function runSimulationStep(deltaSec) {
  const wind = windAt(state.lat, state.lon);
  state.trueWindDir = wind.direction;
  state.trueWindSpeed = wind.speed;

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
  globeCanvas.width = root.clientWidth;
  globeCanvas.height = root.clientHeight;
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
    view.scale = Math.max(0.8, Math.min(1.5, view.scale + (event.deltaY > 0 ? -0.05 : 0.05)));
  });
}

function drawGlobe() {
  const w = globeCanvas.width;
  const h = globeCanvas.height;
  const cx = w * 0.5;
  const cy = h * 0.53;
  const radius = Math.min(w, h) * 0.34 * view.scale;

  globeCtx.clearRect(0, 0, w, h);
  const bg = globeCtx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, radius * 0.2, cx, cy, radius * 1.25);
  bg.addColorStop(0, "#112543");
  bg.addColorStop(1, "#071325");
  globeCtx.fillStyle = bg;
  globeCtx.beginPath();
  globeCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  globeCtx.fill();

  drawGrid(cx, cy, radius);
  drawLand(cx, cy, radius);
  drawTrail(cx, cy, radius);
  drawBoatDot(cx, cy, radius, state.lat, state.lon, "#ffaf66", 4);
  for (const boat of otherBoats) {
    drawBoatDot(cx, cy, radius, boat.lat, boat.lon, boat.color, 3);
  }

  globeCtx.strokeStyle = "#4c78a8";
  globeCtx.globalAlpha = 0.75;
  globeCtx.lineWidth = 1.1;
  globeCtx.beginPath();
  globeCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  globeCtx.stroke();
  globeCtx.globalAlpha = 1;
}

function drawGrid(cx, cy, radius) {
  globeCtx.strokeStyle = "rgba(86, 132, 185, 0.32)";
  globeCtx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 20) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 6) {
      const p = project(lat, lon, cx, cy, radius);
      if (p.visible) pts.push(p);
    }
    strokeProjected(pts);
  }
  for (let lon = -180; lon < 180; lon += 20) {
    const pts = [];
    for (let lat = -80; lat <= 80; lat += 4) {
      const p = project(lat, lon, cx, cy, radius);
      if (p.visible) pts.push(p);
    }
    strokeProjected(pts);
  }
}

function drawLand(cx, cy, radius) {
  const polys = landPolygons();
  for (const poly of polys) {
    const pts = poly.map((p) => project(p.lat, p.lon, cx, cy, radius)).filter((p) => p.visible);
    if (pts.length < 3) continue;
    globeCtx.fillStyle = "rgba(123, 146, 170, 0.88)";
    globeCtx.strokeStyle = "rgba(194, 215, 236, 0.8)";
    globeCtx.lineWidth = 1;
    globeCtx.beginPath();
    globeCtx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) globeCtx.lineTo(pts[i].x, pts[i].y);
    globeCtx.closePath();
    globeCtx.fill();
    globeCtx.stroke();
  }
}

function drawTrail(cx, cy, radius) {
  if (trailPoints.length < 2) return;
  globeCtx.strokeStyle = "rgba(255, 175, 102, 0.8)";
  globeCtx.lineWidth = 1.2;
  const visiblePts = trailPoints.map((p) => project(p.lat, p.lon, cx, cy, radius)).filter((p) => p.visible);
  strokeProjected(visiblePts);
}

function drawBoatDot(cx, cy, radius, lat, lon, color, size) {
  const p = project(lat, lon, cx, cy, radius);
  if (!p.visible) return;
  globeCtx.fillStyle = color;
  globeCtx.beginPath();
  globeCtx.arc(p.x, p.y, size, 0, Math.PI * 2);
  globeCtx.fill();
}

function strokeProjected(points) {
  if (points.length < 2) return;
  globeCtx.beginPath();
  globeCtx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    globeCtx.lineTo(points[i].x, points[i].y);
  }
  globeCtx.stroke();
}

function project(lat, lon, cx, cy, radius) {
  const phi = degToRad(lat);
  const theta = degToRad(lon) + view.rotY;

  let x = Math.cos(phi) * Math.cos(theta);
  let y = Math.sin(phi);
  let z = Math.cos(phi) * Math.sin(theta);

  const ct = Math.cos(view.tilt);
  const st = Math.sin(view.tilt);
  const y2 = y * ct - z * st;
  const z2 = y * st + z * ct;
  y = y2;
  z = z2;

  return {
    x: cx + x * radius,
    y: cy - y * radius,
    visible: z > -0.08,
  };
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function radToDeg(value) {
  return (value * 180) / Math.PI;
}

function landPolygons() {
  return [
    // North America (very simplified mask)
    [
      { lat: 72, lon: -165 },
      { lat: 62, lon: -140 },
      { lat: 52, lon: -129 },
      { lat: 45, lon: -124 },
      { lat: 26, lon: -97 },
      { lat: 11, lon: -82 },
      { lat: 20, lon: -66 },
      { lat: 35, lon: -76 },
      { lat: 49, lon: -60 },
      { lat: 61, lon: -78 },
      { lat: 72, lon: -110 },
    ],
    // South America
    [
      { lat: 12, lon: -81 },
      { lat: 8, lon: -76 },
      { lat: -3, lon: -78 },
      { lat: -16, lon: -74 },
      { lat: -29, lon: -66 },
      { lat: -42, lon: -63 },
      { lat: -52, lon: -70 },
      { lat: -55, lon: -77 },
      { lat: -35, lon: -56 },
      { lat: -10, lon: -48 },
      { lat: 4, lon: -51 },
    ],
    // Europe + North Africa + Asia rough block
    [
      { lat: 70, lon: -10 },
      { lat: 58, lon: 8 },
      { lat: 52, lon: 28 },
      { lat: 44, lon: 42 },
      { lat: 36, lon: 35 },
      { lat: 30, lon: 19 },
      { lat: 23, lon: 11 },
      { lat: 12, lon: -5 },
      { lat: 8, lon: 12 },
      { lat: 1, lon: 34 },
      { lat: -9, lon: 41 },
      { lat: -27, lon: 32 },
      { lat: -34, lon: 19 },
      { lat: -23, lon: 13 },
      { lat: -2, lon: 4 },
      { lat: 11, lon: 43 },
      { lat: 19, lon: 65 },
      { lat: 30, lon: 88 },
      { lat: 41, lon: 104 },
      { lat: 52, lon: 124 },
      { lat: 62, lon: 142 },
      { lat: 58, lon: 164 },
      { lat: 48, lon: 149 },
      { lat: 35, lon: 128 },
      { lat: 23, lon: 118 },
      { lat: 14, lon: 103 },
      { lat: 5, lon: 101 },
      { lat: -5, lon: 116 },
      { lat: -9, lon: 130 },
      { lat: 5, lon: 145 },
      { lat: 24, lon: 134 },
      { lat: 38, lon: 112 },
      { lat: 50, lon: 91 },
      { lat: 58, lon: 66 },
      { lat: 62, lon: 43 },
      { lat: 67, lon: 18 },
    ],
    // Australia
    [
      { lat: -12, lon: 113 },
      { lat: -21, lon: 114 },
      { lat: -34, lon: 116 },
      { lat: -39, lon: 131 },
      { lat: -35, lon: 147 },
      { lat: -28, lon: 153 },
      { lat: -18, lon: 147 },
      { lat: -13, lon: 134 },
    ],
    // Greenland
    [
      { lat: 83, lon: -72 },
      { lat: 78, lon: -45 },
      { lat: 72, lon: -22 },
      { lat: 61, lon: -40 },
      { lat: 62, lon: -52 },
      { lat: 70, lon: -62 },
    ],
  ];
}
