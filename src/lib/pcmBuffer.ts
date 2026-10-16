export class PcmBuffer {
  private readonly samples: Float32Array;
  private head = 0;
  private count = 0;
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid audio buffer capacity');
    this.samples = new Float32Array(capacity);
  }
  get available(): number { return this.count; }
  push(input: Float32Array): boolean {
    const accepted = Math.min(input.length, this.samples.length - this.count);
    for (let i = 0; i < accepted; i++) this.samples[(this.head + this.count + i) % this.samples.length] = input[i];
    this.count += accepted;
    return accepted === input.length;
  }
  read(output: Float32Array): void {
    output.fill(0);
    const amount = Math.min(output.length, this.count);
    for (let i = 0; i < amount; i++) {
      output[i] = this.samples[this.head];
      this.samples[this.head] = 0;
      this.head = (this.head + 1) % this.samples.length;
    }
    this.count -= amount;
  }
  clear(): void { this.samples.fill(0); this.head = 0; this.count = 0; }
}
