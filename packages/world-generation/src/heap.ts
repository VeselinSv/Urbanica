/** Минимална двоична купчина (приоритет, цяло число). При равен приоритет печели по-малката стойност – детерминистично. */
export class MinHeap {
  private pr: Float64Array;
  private val: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.pr = new Float64Array(capacity);
    this.val = new Int32Array(capacity);
  }

  private less(i: number, j: number) {
    return this.pr[i] < this.pr[j] || (this.pr[i] === this.pr[j] && this.val[i] < this.val[j]);
  }

  private swap(i: number, j: number) {
    const p = this.pr[i];
    this.pr[i] = this.pr[j];
    this.pr[j] = p;
    const v = this.val[i];
    this.val[i] = this.val[j];
    this.val[j] = v;
  }

  push(priority: number, value: number) {
    if (this.size === this.pr.length) {
      const pr = new Float64Array(this.size * 2);
      pr.set(this.pr);
      const val = new Int32Array(this.size * 2);
      val.set(this.val);
      this.pr = pr;
      this.val = val;
    }
    let i = this.size++;
    this.pr[i] = priority;
    this.val[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Връща стойността с най-малък приоритет. */
  pop(): number {
    const top = this.val[0];
    this.size--;
    if (this.size > 0) {
      this.pr[0] = this.pr[this.size];
      this.val[0] = this.val[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  peekPriority(): number {
    return this.pr[0];
  }

  clear() {
    this.size = 0;
  }
}
