import { Component, type ReactNode } from 'react';

/** 局部出错只坏这一块（比如离线时白模的代码没缓存到），不把整页带崩。 */
export default class SafeBox extends Component<{ children: ReactNode; fallback: (e: Error) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}
