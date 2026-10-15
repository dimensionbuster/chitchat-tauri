import { shallowRef, getCurrentScope, onScopeDispose, type Ref } from 'vue'
import type { Store } from '@/core/store'

/** core Store를 Vue ref로 변환. 컴포넌트/이펙트 스코프가 있으면 종료 시 구독 해제. */
export function useStore<T>(store: Store<T>): Readonly<Ref<T>> {
  const state = shallowRef(store.get()) as Ref<T>
  const unsubscribe = store.subscribe(v => {
    state.value = v
  })
  if (getCurrentScope()) onScopeDispose(unsubscribe)
  return state
}
