class LatestRequestGate {
  constructor() { this.generation = 0; }
  request() { this.generation += 1; return this.generation; }
  current() { return this.generation; }
  isCurrent(generation) { return generation === this.generation; }
  invalidate() { this.generation += 1; }
}

module.exports = { LatestRequestGate };
