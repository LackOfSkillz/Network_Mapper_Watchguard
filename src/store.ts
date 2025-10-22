import { create } from 'zustand'

export type Firewall = {
  id: string; name: string; model?: string;
  interfaces: Interface[];
  networks: Network[];
  addressGroups: AddressGroup[];
  services: Service[];
  policies: Policy[];
  routes: Route[];
}

export type Interface = { name: string; ip?: string; cidr?: string; zone?: string }
export type Network  = { cidr: string; desc: string; viaInterface: string; firewallId: string }
export type AddressGroup = { name: string; members: Array<{kind:'host'|'network'|'range', value:string}> }
export type Service = { name: string; members: Array<{proto:string, port:string}> }
export type Policy = { name: string; enabled: boolean; from: string[]; to: string[]; services: string[] }
export type Route  = { dest: string; nextHop?: string; egressIf?: string }

type State = {
  firewalls: Firewall[]
  selectedNetwork?: string
  selectedHost?: string
  selectedPolicy?: string
  set: (s: Partial<State> | ((s: State)=>Partial<State>)) => void
}

export const useStore = create<State>((set) => ({
  firewalls: [],
  selectedNetwork: undefined,
  selectedHost: undefined,
  selectedPolicy: undefined,
  set: (u) => set((s) => ({ ...s, ...(typeof u === 'function' ? (u as any)(s) : u) })),
}))
