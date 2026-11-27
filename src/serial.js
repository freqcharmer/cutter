// Web Serial connection to the cutter. Chrome/Edge only, https or localhost only.
export const supported = () => 'serial' in navigator;

export class Cutter {
  constructor(log) {
    this.log = log;
    this.port = null;
    this.writer = null;
    this.cancelled = false;
    this.onchange = () => {};
    if (supported()) {
      navigator.serial.addEventListener('disconnect', (e) => {
        if (e.target === this.port) { this.writer = null; this.log('Cutter unplugged or turned off.'); this.onchange(); }
      });
    }
  }

  get connected() { return !!this.writer; }

  /** Uses a port this site was already allowed to use, or opens Chrome's picker. */
  async choose({ forcePicker = false } = {}) {
    if (!forcePicker) {
      const known = await navigator.serial.getPorts();
      if (known.length) { this.port = known[0]; this.describe('Using previously allowed port.'); return; }
    }
    this.port = await navigator.serial.requestPort();
    this.describe('Port selected.');
  }

  describe(prefix) {
    const info = this.port.getInfo();
    const hex = (n) => (n == null ? 'unknown' : '0x' + n.toString(16).padStart(4, '0'));
    this.log(`${prefix} USB vendor ${hex(info.usbVendorId)}, product ${hex(info.usbProductId)}.`);
  }

  async open({ baudRate = 9600, flowControl = 'none' } = {}) {
    if (!this.port) throw new Error('Choose a port first.');
    try {
      await this.port.open({ baudRate, dataBits: 8, parity: 'none', stopBits: 1, flowControl });
    } catch (err) {
      if (!/already open/i.test(err.message)) throw err;
    }
    this.writer = this.port.writable.getWriter();
    this.log(`Connected at ${baudRate} baud, flow control ${flowControl}.`);
    this.onchange();
  }

  /** Sends text in small chunks so the cutter's buffer can keep up. */
  async send(text, { chunk = 64, delayMs = 20, onProgress } = {}) {
    if (!this.writer) throw new Error('The cutter is not connected.');
    const enc = new TextEncoder();
    this.cancelled = false;
    for (let i = 0; i < text.length; i += chunk) {
      if (this.cancelled) { this.log('Send stopped. The cutter may finish what is already in its buffer.'); return false; }
      await this.writer.write(enc.encode(text.slice(i, i + chunk)));
      onProgress?.(Math.min(1, (i + chunk) / text.length));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    return true;
  }

  stop() { this.cancelled = true; }

  async close() {
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.writer = null;
    this.log('Disconnected.');
    this.onchange();
  }
}
