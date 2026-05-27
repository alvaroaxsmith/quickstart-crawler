import { describe, expect, it, vi } from 'vitest'
import { InMemorySemaphoreQueue } from '../../../../src/infrastructure/concurrency/in-memory-job-queue.impl.js'

describe('InMemorySemaphoreQueue', () => {
  it('limits concurrent handlers to the configured size', async () => {
    const queue = new InMemorySemaphoreQueue<number>()
    let active = 0
    let maxActive = 0
    const handler = async (): Promise<void> => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
    }
    await queue.process(handler, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(queue.getStats()).toMatchObject({ completed: 10, failed: 0, active: 0 })
  })

  it('counts failures without stopping the batch', async () => {
    const queue = new InMemorySemaphoreQueue<number>()
    const handler = vi.fn(async (n: number) => {
      if (n % 2 === 0) throw new Error('boom')
    })
    await queue.process(handler, 2, [1, 2, 3, 4, 5])
    expect(handler).toHaveBeenCalledTimes(5)
    expect(queue.getStats()).toMatchObject({ completed: 3, failed: 2 })
  })

  it('throws on invalid concurrency', async () => {
    const queue = new InMemorySemaphoreQueue<number>()
    await expect(queue.process(async () => {}, 0, [1])).rejects.toThrow()
    await expect(queue.process(async () => {}, -1, [1])).rejects.toThrow()
  })

  it('resolves immediately for empty job list', async () => {
    const queue = new InMemorySemaphoreQueue<number>()
    await queue.process(async () => {}, 4, [])
    expect(queue.getStats()).toMatchObject({ pending: 0, completed: 0, failed: 0 })
  })
})
