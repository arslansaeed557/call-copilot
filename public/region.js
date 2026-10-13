/* Fullscreen region selector over a frozen capture. */

const $ = (id) => document.getElementById(id);
const api = window.desktop?.region;

let rect = null;      // in CSS pixels
let dragging = false;
let origin = null;

api?.onImage(({ dataUrl }) => {
  $('frame').src = dataUrl;
});

function paint() {
  const el = $('sel');
  if (!rect || rect.width < 2 || rect.height < 2) {
    el.hidden = true;
    $('shade').style.display = '';
    return;
  }
  el.hidden = false;
  // The selection's own huge box-shadow does the dimming once it exists.
  $('shade').style.display = 'none';
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  $('dims').textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

function normalised() {
  return {
    x: rect.x / window.innerWidth,
    y: rect.y / window.innerHeight,
    width: rect.width / window.innerWidth,
    height: rect.height / window.innerHeight,
  };
}

function send() {
  if (!rect || rect.width < 8 || rect.height < 8) return;
  api?.submit({ ok: true, rect: normalised(), note: $('note').value.trim() });
}

function cancel() {
  api?.submit({ ok: false, cancelled: true });
}

document.addEventListener('mousedown', (e) => {
  // Clicks inside the prompt bar are for typing, not for starting a new drag.
  if (e.target.closest('.ask')) return;
  dragging = true;
  origin = { x: e.clientX, y: e.clientY };
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
  $('ask').hidden = true;
  $('hint').hidden = false;
  paint();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  rect = {
    x: Math.min(origin.x, e.clientX),
    y: Math.min(origin.y, e.clientY),
    width: Math.abs(e.clientX - origin.x),
    height: Math.abs(e.clientY - origin.y),
  };
  paint();
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (!rect || rect.width < 8 || rect.height < 8) {
    rect = null;
    paint();
    return;
  }
  $('hint').hidden = true;
  $('ask').hidden = false;
  $('note').focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    send();
  }
});

$('go').onclick = send;
$('cancel').onclick = cancel;
