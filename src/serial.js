// Web Serial connection to the cutter. Chrome/Edge only, https or localhost only.
export const supported = () => 'serial' in navigator;

export class Cutter {
  constructor(log) {
    this.log = log;
    this.port = null;
    this.writer = null;
  }

  /** Opens Chrome's port picker. If the MH 871 appears there, the browser can reach it. */
  async choose() {
    this.port = await navigator.serial.requestPort();
    const info = this.port.getInfo();
    const hex = (n) => (n == null ? 'unknown' : '0x' + n.toString(16).padStart(4, '0'));
    this.log(`Port selected. USB vendor ${hex(info.usbVendorId)}, product ${hex(info.usbProductId)}`);
    return info;
  }

  async open({ baudRate = 9600 } = {}) {
    if (!this.port) throw new Error('Choose a port first.');
    await this.port.open({ baudRate, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' });
    this.writer = this.port.writable.getWriter();
    this.log(`Opened at ${baudRate} baud.`);
  }

  /** Sends text in small chunks so the cutter's buffer can keep up. */
  async send(text, chunk = 64, delayMs = 20) {
    if (!this.writer) throw new Error('Port is not open.');
    const enc = new TextEncoder();
    this.log(`TX ${text}`);
    for (let i = 0; i < text.length; i += chunk) {
      await this.writer.write(enc.encode(text.slice(i, i + chunk)));
      await new Promise((r) => setTimeout(r, delayMs));
    }
    this.log('Send complete.');
  }

  async close() {
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.writer = null;
    this.log('Closed.');
  }
}
