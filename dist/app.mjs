const $ = (id) => document.getElementById(id);
const video = $('camera');
const canvas = $('field');
const ctx = canvas.getContext('2d');
const speeds = {
  chill: { fall: 155, interval: 1.55 },
  classic: { fall: 290, interval: 1.1 },
  blitz: { fall: 455, interval: 0.72 },
};
const palette = [
  ['#f45756', '#ffa09b', '#ffe1ac'],
  ['#ffa234', '#ffca75', '#fff1a4'],
  ['#8bcb48', '#c8ed70', '#e6f8a8'],
  ['#ad76ed', '#dcb0ff', '#ffe1ee'],
];
const bones = [[0,5],[0,17],[5,9],[9,13],[13,17]];
for (const base of [1,5,9,13,17]) {
  bones.push([0, base], [base, base+1], [base+1, base+2], [base+2, base+3]);
}

let tracker, stream, frame, mode, settings, pointer;
let generation = 0;
let width = 960, height = 600;
let fruits = [], pieces = [], hands = new Map(), strokes = [];
let untilBomb = 0;
let score = 0, misses = 0, nextFruit = 0, previousTime = 0;
let lastDetection = 0, lastVideoTime = -1;

function status(label, live = false) {
  if ($('camera-status').textContent !== label) $('camera-status').textContent = label;
  $('camera-status').classList.toggle('live', live);
}

function hud() {
  $('score').textContent = String(score).padStart(2, '0');
  $('misses').setAttribute('aria-label', `${misses} of 3 strikes`);
  [...$('misses').children].forEach((mark, index) => mark.classList.toggle('used', index < misses));
}

function stop() {
  generation++;
  cancelAnimationFrame(frame);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  video.classList.remove('live');
  tracker?.close();
  tracker = null;
  mode = null;
  pointer = null;
  hands.clear();
  $('end').hidden = true;
  $('start').disabled = false;
  $('practice').disabled = false;
  document.querySelectorAll('[name="speed"]').forEach((input) => { input.disabled = false; });
  status('CAMERA OFF');
}

function showResult(title, message, label = 'ROUND OVER') {
  stop();
  $('overlay').hidden = false;
  $('eyebrow').textContent = label;
  $('headline').textContent = title;
  $('message').textContent = message;
  $('start').firstChild.textContent = 'Enable camera & play ';
  $('start').focus();
}

function begin(inputMode) {
  mode = inputMode;
  settings = speeds[document.querySelector('[name="speed"]:checked').value];
  fruits = [];
  pieces = [];
  strokes = [];
  score = 0;
  misses = 0;
  previousTime = 0;
  lastDetection = 0;
  lastVideoTime = -1;
  nextFruit = 0.85;
  untilBomb = 5;
  hud();
  $('overlay').hidden = true;
  $('end').hidden = false;
  $('end').focus();
  document.querySelectorAll('[name="speed"]').forEach((input) => { input.disabled = true; });
  status(inputMode === 'camera' ? 'SHOW YOUR HAND' : 'POINTER PRACTICE', true);
  frame = requestAnimationFrame(tick);
}

async function startCamera() {
  stop();
  const ticket = generation;
  $('start').disabled = true;
  $('practice').disabled = true;
  $('start').firstChild.textContent = 'Starting camera… ';
  $('message').textContent = 'Allow camera access when your browser asks.';
  status('STARTING CAMERA');
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Error('Open the game on localhost or HTTPS to enable the camera.');
    const camera = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    if (ticket !== generation) {
      camera.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = camera;
    camera.getVideoTracks()[0].addEventListener('ended', () => {
      if (ticket === generation) showResult('Camera disconnected', 'Reconnect your camera and try again.', 'CAMERA OFF');
    });
    video.srcObject = camera;
    $('message').textContent = 'Loading the hand tracker…';
    const { FilesetResolver, HandLandmarker } = await import('./vision/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks('./vision/wasm');
    const handTracker = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: './vision/hand_landmarker.task', delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
    if (ticket !== generation) {
      handTracker.close();
      return;
    }
    tracker = handTracker;
    await video.play();
    if (ticket !== generation) return;
    video.classList.add('live');
    begin('camera');
  } catch (error) {
    if (ticket !== generation) return;
    const message = error.name === 'NotAllowedError'
      ? 'Allow camera access in your browser or system settings, then try again.'
      : error.name === 'NotFoundError'
        ? 'Connect a camera, then try again.'
        : error.message || 'Try opening the camera again.';
    showResult('Camera unavailable', message, 'CAMERA SETUP');
  }
}

function resize() {
  const { clientWidth, clientHeight } = canvas;
  if (!clientWidth || !clientHeight) return;
  const nextWidth = 960;
  const nextHeight = nextWidth * clientHeight / clientWidth;
  if (nextHeight === height) return;
  const ratio = nextHeight / height;
  for (const fruit of fruits) fruit.y *= ratio;
  for (const piece of pieces) piece.y *= ratio;
  height = nextHeight;
  hands.clear();
  strokes = [];
  pointer = null;
  const resolution = Math.min(devicePixelRatio, 2);
  canvas.width = Math.round(clientWidth * resolution);
  canvas.height = Math.round(clientHeight * resolution);
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
}
new ResizeObserver(resize).observe(canvas);

function detect(now) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime || now - lastDetection < 32) return;
  lastVideoTime = video.currentTime;
  const recent = now - lastDetection < 130;
  lastDetection = now;
  const result = tracker.detectForVideo(video, now);
  const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
  const imageWidth = video.videoWidth * scale;
  const imageHeight = video.videoHeight * scale;
  const next = new Map();
  strokes = [];
  result.landmarks.forEach((landmarks, index) => {
    const key = result.handedness[index]?.[0]?.categoryName ?? index;
    const points = landmarks.map(({ x, y }) => ({
      x: (1 - x) * imageWidth + (width - imageWidth) / 2,
      y: y * imageHeight + (height - imageHeight) / 2,
    }));
    const previous = recent ? hands.get(key) : null;
    if (previous) {
      for (const i of [4,8,12,16,20,9]) {
        if (Math.hypot(previous[i].x - points[i].x, previous[i].y - points[i].y) < width * .45) {
          strokes.push([previous[i], points[i]]);
        }
      }
    }
    next.set(key, points);
  });
  hands = next;
  status(hands.size ? `${hands.size} HAND${hands.size === 1 ? '' : 'S'} TRACKED` : 'SHOW YOUR HAND', true);
}

function intersects(fruit, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((fruit.x - a.x) * dx + (fruit.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(fruit.x - a.x - dx * t, fruit.y - a.y - dy * t) <= fruit.radius + 5;
}

function spawn() {
  const bomb = --untilBomb === 0;
  if (bomb) untilBomb = 4 + Math.floor(Math.random() * 3);
  const radius = 33 + Math.random() * 12;
  fruits.push({
    x: 95 + Math.random() * (width - 190), y: -radius,
    vx: (Math.random() - .5) * 130, vy: settings.fall * height / 600,
    bomb, radius, angle: 0, spin: (Math.random() - .5) * 2.8,
    colors: palette[Math.floor(Math.random() * palette.length)],
  });
}

function slice(fruit) {
  score++;
  hud();
  for (const side of [-1, 1]) {
    pieces.push({ ...fruit, x: fruit.x + side * 4, vx: fruit.vx + side * 145,
      vy: 55, spin: side * 5, side, life: .66 });
  }
  for (let i = 0; i < 10; i++) {
    const direction = i * Math.PI / 5;
    const speed = 80 + Math.random() * 190;
    pieces.push({ x: fruit.x, y: fruit.y, vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed, color: fruit.colors[1], life: .42 });
  }
}

function drawFruit(fruit) {
  const { x, y, radius: r, colors, angle, side } = fruit;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (fruit.bomb) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.fillStyle = '#20181e';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ff7777';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(r * .28, -r * .94);
    ctx.quadraticCurveTo(r * .42, -r * 1.4, r * .73, -r * 1.28);
    ctx.strokeStyle = '#ffc47b';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r * .76, -r * 1.28, 6, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff0aa';
    ctx.fill();
    ctx.fillStyle = '#ff9696';
    ctx.font = `800 ${r * 1.35}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 0, 2);
  } else if (side) {
    ctx.globalAlpha = Math.min(1, fruit.life * 4);
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, side === -1);
    ctx.closePath();
    ctx.fillStyle = colors[2];
    ctx.fill();
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = colors[0];
    for (const dy of [-.35, 0, .35]) {
      ctx.beginPath();
      ctx.ellipse(side * r * .34, dy * r, 2.5, 5, -.4, 0, 2 * Math.PI);
      ctx.fill();
    }
  } else {
    const gradient = ctx.createRadialGradient(-r * .36, -r * .45, 0, 0, 0, r);
    gradient.addColorStop(0, colors[1]);
    gradient.addColorStop(1, colors[0]);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * .94, 0, 0, 2 * Math.PI);
    ctx.fillStyle = gradient;
    ctx.shadowColor = '#0007';
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#d8f575';
    ctx.beginPath();
    ctx.ellipse(r * .2, -r * .91, r * .36, r * .13, -.58, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

function paint() {
  ctx.clearRect(0, 0, width, height);
  for (const fruit of fruits) drawFruit(fruit);
  for (const piece of pieces) {
    if (piece.side) {
      drawFruit(piece);
    } else {
      ctx.globalAlpha = Math.min(1, piece.life * 5);
      ctx.fillStyle = piece.color;
      ctx.beginPath();
      ctx.arc(piece.x, piece.y, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#d8f575b0';
  ctx.lineWidth = 3;
  for (const points of hands.values()) {
    ctx.beginPath();
    for (const [a, b] of bones) {
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#f4ffcf';
  for (const point of [...hands.values()].flatMap((points) => [points[4],points[8],points[12],points[16],points[20]]).concat(pointer || [])) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 6, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function tick(now) {
  const dt = previousTime ? Math.min((now - previousTime) / 1000, .05) : 0;
  previousTime = now;
  if (mode === 'camera') {
    try {
      detect(now);
    } catch (error) {
      showResult('Tracking interrupted', error.message || 'Try starting the camera again.', 'CAMERA ERROR');
      return;
    }
  }
  nextFruit -= dt;
  if (nextFruit <= 0) {
    spawn();
    nextFruit += settings.interval;
  }

  const segments = [...strokes];
  strokes = [];
  if (pointer) segments.push([pointer, pointer]);
  for (const points of hands.values()) {
    for (const [a, b] of bones) segments.push([points[a], points[b]]);
  }

  const remaining = [];
  for (const fruit of fruits) {
    fruit.x += fruit.vx * dt;
    fruit.y += fruit.vy * dt;
    fruit.angle += fruit.spin * dt;
    if (fruit.x < fruit.radius || fruit.x > width - fruit.radius) {
      fruit.x = Math.max(fruit.radius, Math.min(width - fruit.radius, fruit.x));
      fruit.vx *= -1;
    }
    const offscreen = fruit.y - fruit.radius > height;
    const hit = !offscreen && fruit.y + fruit.radius > 0 &&
      segments.some(([a, b]) => intersects(fruit, a, b));
    if (hit && !fruit.bomb) {
      slice(fruit);
    } else if ((hit && fruit.bomb) || (offscreen && !fruit.bomb)) {
      if (hit) {
        score -= 10;
        for (let i = 0; i < 12; i++) {
          const angle = i * Math.PI / 6;
          pieces.push({ x: fruit.x, y: fruit.y, vx: Math.cos(angle) * 230,
            vy: Math.sin(angle) * 230, color: i % 2 ? '#ff7777' : '#ffc47b', life: .45 });
        }
      }
      misses++;
      hud();
      if (misses === 3) {
        const reason = hit ? 'Bomb hit. ' : '';
        showResult('Three strikes.', `${reason}Final score: ${score}. Pick a speed and play again.`);
        return;
      }
    } else if (!offscreen) {
      remaining.push(fruit);
    }
  }
  fruits = remaining;
  for (const piece of pieces) {
    piece.life -= dt;
    piece.x += piece.vx * dt;
    piece.y += piece.vy * dt;
    piece.vy += 460 * dt;
    if (piece.side) piece.angle += piece.spin * dt;
  }
  pieces = pieces.filter((piece) => piece.life > 0);
  paint();
  frame = requestAnimationFrame(tick);
}

function movePointer(event) {
  if (mode !== 'practice' || (event.pointerType !== 'mouse' && !event.buttons)) return;
  const rect = canvas.getBoundingClientRect();
  const next = { x: (event.clientX - rect.left) * width / rect.width,
    y: (event.clientY - rect.top) * height / rect.height };
  if (pointer) strokes.push([pointer, next]);
  pointer = next;
}
canvas.addEventListener('pointermove', movePointer);
canvas.addEventListener('pointerdown', movePointer);
for (const type of ['pointerleave', 'pointercancel']) {
  canvas.addEventListener(type, () => { pointer = null; });
}
canvas.addEventListener('pointerup', (event) => {
  if (event.pointerType !== 'mouse') pointer = null;
});

$('start').addEventListener('click', startCamera);
$('practice').addEventListener('click', () => { stop(); begin('practice'); });
$('end').addEventListener('click', () => showResult('Round ended', `Final score: ${score}. Pick a speed to play again.`));
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (mode === 'camera' || $('start').disabled)) {
    showResult('Camera turned off', 'Start a new round when you’re ready.', 'CAMERA OFF');
  }
});
window.addEventListener('pagehide', stop);
