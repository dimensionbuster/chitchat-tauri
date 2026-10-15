/**
 * 프레임워크 독립 최소 반응형 저장소.
 * UI 계층(Vue/React 등)은 subscribe로 구독해 자기 상태로 변환한다.
 */
export interface Store<T> {
  get(): T
  set(value: T): void
  subscribe(listener: (value: T) => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<(value: T) => void>()
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach(l => l(value))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
