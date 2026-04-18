import { createContext, useContext } from 'react'

export const CwdContext = createContext<string>('')

export function useCwd(): string {
  return useContext(CwdContext)
}
