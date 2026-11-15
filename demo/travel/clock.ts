// The demo's clock: Date runs from a chosen moment, still ticking. Imported before anything else.
const Real = Date;
let off = 0;
export function setNow(iso: string) {
  off = Real.parse(iso) - Real.now();
}
class DemoDate extends Real {
  constructor(...a: unknown[]) {
    if (a.length) super(...(a as [number]));
    else super(Real.now() + off);
  }
  static now() {
    return Real.now() + off;
  }
}
globalThis.Date = DemoDate as DateConstructor;
