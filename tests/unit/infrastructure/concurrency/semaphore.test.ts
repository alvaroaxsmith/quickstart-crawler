import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../../../src/infrastructure/concurrency/semaphore.util.js'

describe('Semaphore', () => {
  it('permits initial concurrent acquires up to capacity', async () => {
    const sem = new Semaphore(2)
    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.available).toBe(0)
    expect(sem.pending).toBe(0)
    r1()
    r2()
  })

  it('queues callers in FIFO order when capacity is exhausted', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    const r1 = await sem.acquire()

    const p2 = sem.acquire().then((r) => {
      order.push(2)
      r()
    })
    const p3 = sem.acquire().then((r) => {
      order.push(3)
      r()
    })
    const p4 = sem.acquire().then((r) => {
      order.push(4)
      r()
    })

    expect(sem.pending).toBe(3)
    r1()
    await Promise.all([p2, p3, p4])
    expect(order).toEqual([2, 3, 4])
  })

  it('treats double-release as a no-op (does not over-grant permits)', async () => {
    const sem = new Semaphore(1)
    const release = await sem.acquire()
    release()
    release()
    release()
    expect(sem.available).toBe(1)
  })

  it('throws when constructed with invalid permits', () => {
    expect(() => new Semaphore(0)).toThrow()
    expect(() => new Semaphore(-1)).toThrow()
    expect(() => new Semaphore(1.5)).toThrow()
  })

  it('rejects acquires after close() and frees pending waiters', async () => {
    const sem = new Semaphore(1)
    const r1 = await sem.acquire()
    let waiterReleased = false
    const p2 = sem.acquire().then((r) => {
      r()
      waiterReleased = true
    })
    sem.close()
    await p2
    expect(waiterReleased).toBe(true)
    await expect(sem.acquire()).rejects.toThrow(/closed/)
    r1()
  })
})
