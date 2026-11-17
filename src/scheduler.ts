export class DeadlineError extends Error {
  constructor(message = "arena deadline reached") {
    super(message)
    this.name = "DeadlineError"
  }
}

export class AbortError extends Error {
  constructor(message = "arena stopped") {
    super(message)
    this.name = "AbortError"
  }
}

export class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    return () => this.release()
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
