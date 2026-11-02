import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionStatus } from "../shared/types";

type Notice = { tone: "success" | "error" | "warning"; message: string } | null;
type AppStore = {
  session: SessionStatus | null;
  /** 当前正在查看的账户；所有账户都在后台同时运行。 */
  currentAccountId: string | null;
  /** 正在添加新账户（显示登录页，但保留已登录账户）。 */
  addingAccount: boolean;
  setCurrentAccountId: (id: string | null) => void;
  setAddingAccount: (adding: boolean) => void;
  mobileNavOpen: boolean;
  notice: Notice;
  theme: "light" | "dark";
  setSession: (session: SessionStatus | null) => void;
  setMobileNavOpen: (open: boolean) => void;
  setNotice: (notice: Notice) => void;
  setTheme: (theme: "light" | "dark") => void;
  toggleTheme: () => void;
};

export const useAppStore = create<AppStore>()(persist((set) => ({
  session: null,
  currentAccountId: null,
  addingAccount: false,
  setCurrentAccountId: (currentAccountId) => set({ currentAccountId }),
  setAddingAccount: (addingAccount) => set({ addingAccount }),
  mobileNavOpen: false,
  notice: null,
  theme: "light",
  setSession: (session) => set((state) => ({
    session,
    currentAccountId: session?.accountId ?? state.currentAccountId,
  })),
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setNotice: (notice) => set({ notice }),
  setTheme: (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return set({ theme });
  },
  toggleTheme: () => set((state) => {
    const theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
    return { theme };
  }),
}), { name: "hdu-sniper-preferences", partialize: (state) => ({ theme: state.theme, currentAccountId: state.currentAccountId }) }));

export function initializeTheme() {
  const theme = useAppStore.getState().theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}
