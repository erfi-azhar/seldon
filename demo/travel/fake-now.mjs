// Preload: moves the server's clock to FAKE_NOW (an ISO instant), still ticking from there.
const off = Date.parse(process.env.FAKE_NOW) - Date.now();
const Real = Date;
globalThis.Date = class extends Real {
  constructor(...a) { a.length ? super(...a) : super(Real.now() + off); }
  static now() { return Real.now() + off; }
};
