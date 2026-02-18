import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/services/api";
import { useSettingsStore } from "./settingsStore";
import Logger from "@/utils/Logger";
import { LoginCredentialsManager } from "@/services/storage";

const logger = Logger.withTag("AuthStore");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const validateSession = async (): Promise<boolean> => {
  try {
    await api.getPlayRecords();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return false;
    }

    await sleep(400);
    try {
      await api.getPlayRecords();
      return true;
    } catch (retryError) {
      if (retryError instanceof Error && retryError.message === "UNAUTHORIZED") {
        return false;
      }
      throw retryError;
    }
  }
};

const tryAutoLogin = async (storageType: string | undefined): Promise<boolean> => {
  const isLocalStorage = storageType === "localstorage";
  const savedCredentials = await LoginCredentialsManager.get();

  if (isLocalStorage) {
    const loginResult = await api.login(undefined, savedCredentials?.password).catch(() => null);
    return !!loginResult?.ok;
  }

  if (!savedCredentials?.username || !savedCredentials?.password) {
    return false;
  }

  const loginResult = await api.login(savedCredentials.username, savedCredentials.password).catch(() => null);
  return !!loginResult?.ok;
};

interface AuthState {
  isLoggedIn: boolean;
  isLoginModalVisible: boolean;
  showLoginModal: () => void;
  hideLoginModal: () => void;
  checkLoginStatus: (apiBaseUrl?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  isLoginModalVisible: false,
  showLoginModal: () => set({ isLoginModalVisible: true }),
  hideLoginModal: () => set({ isLoginModalVisible: false }),
  checkLoginStatus: async (apiBaseUrl?: string) => {
    if (!apiBaseUrl) {
      set({ isLoggedIn: false, isLoginModalVisible: false });
      return;
    }

    api.setBaseUrl(apiBaseUrl);
    set({ isLoginModalVisible: false });

    try {
      const settingsState = useSettingsStore.getState();
      if (!settingsState.serverConfig?.StorageType) {
        await settingsState.fetchServerConfig();
      }

      const refreshedSettings = useSettingsStore.getState();
      const storageType = refreshedSettings.serverConfig?.StorageType;

      if (!storageType) {
        set({ isLoggedIn: false, isLoginModalVisible: false });
        return;
      }

      const authToken = await AsyncStorage.getItem("authCookies");
      if (authToken) {
        const isSessionValid = await validateSession();
        if (isSessionValid) {
          set({ isLoggedIn: true, isLoginModalVisible: false });
          return;
        }

        await AsyncStorage.setItem("authCookies", "");
      }

      const hasAutoLogin = await tryAutoLogin(storageType);
      if (hasAutoLogin) {
        set({ isLoggedIn: true, isLoginModalVisible: false });
        return;
      }

      if (storageType === "localstorage") {
        set({ isLoggedIn: false, isLoginModalVisible: false });
      } else {
        set({ isLoggedIn: false, isLoginModalVisible: true });
      }
    } catch (error) {
      logger.error("Failed to check login status:", error);
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        const hasAutoLogin = await tryAutoLogin(useSettingsStore.getState().serverConfig?.StorageType);
        if (hasAutoLogin) {
          set({ isLoggedIn: true, isLoginModalVisible: false });
          return;
        }
        set({ isLoggedIn: false, isLoginModalVisible: true });
      } else {
        const authToken = await AsyncStorage.getItem("authCookies");
        if (authToken) {
          set({ isLoggedIn: true, isLoginModalVisible: false });
        } else {
          set({ isLoggedIn: false, isLoginModalVisible: true });
        }
      }
    }
  },
  logout: async () => {
    try {
      await api.logout();
      set({ isLoggedIn: false, isLoginModalVisible: true });
    } catch (error) {
      logger.error("Failed to logout:", error);
    }
  },
}));

export default useAuthStore;
