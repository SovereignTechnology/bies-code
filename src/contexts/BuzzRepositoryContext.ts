import { createContext, useContext } from "react";

export const BuzzRepositoryContext = createContext(false);

export function useIsBuzzRepository(): boolean {
  return useContext(BuzzRepositoryContext);
}
