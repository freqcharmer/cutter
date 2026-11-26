import { Cutter, supported } from './serial.js';
import { buildJob, testSquare } from './hpgl.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (msg) => {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

const cutter = new Cutter(log);

if (!supported()) {
  $('support').textContent = 'This browser cannot talk to cutters. Open FantastiCut in Chrome or Edge on a computer.';
  $('choose').disabled = true;
}

const run = (fn) => async () => {
  try { await fn(); } catch (e) { log(`ERROR: ${e.message}`); }
};

$('choose').onclick = run(async () => {
  await cutter.choose();
  $('open').disabled = false;
});

$('open').onclick = run(async () => {
  await cutter.open({ baudRate: Number($('baud').value) });
  $('open').disabled = true;
  $('close').disabled = false;
  $('cut').disabled = false;
});

$('close').onclick = run(async () => {
  await cutter.close();
  $('open').disabled = false;
  $('close').disabled = true;
  $('cut').disabled = true;
});

$('cut').onclick = run(async () => {
  const job = buildJob(testSquare(1, 0.5), {
    speed: Number($('speed').value),
    force: Number($('force').value),
  });
  await cutter.send(job);
});

$('copy').onclick = run(async () => {
  await navigator.clipboard.writeText(logEl.textContent);
  log('Log copied to clipboard.');
});

log(`FantastiCut ready. Web Serial ${supported() ? 'available' : 'NOT available'}.`);
