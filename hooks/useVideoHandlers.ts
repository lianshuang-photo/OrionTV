import { RefObject, useCallback, useEffect, useMemo } from "react";
import { ResizeMode, Video } from "expo-av";
import Toast from "react-native-toast-message";
import {
  createDiscontinuityFilteredM3u8Url,
  isHttpLiveUrl,
  isM3u8LiveUrl,
} from "@/services/m3u";
import usePlayerStore from "@/stores/playerStore";
import { useSettingsStore } from "@/stores/settingsStore";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("VideoHandlers");

interface CurrentEpisode {
  url: string;
  title: string;
  rawUrl?: string;
}

interface UseVideoHandlersProps {
  videoRef: RefObject<Video>;
  currentEpisode: CurrentEpisode | undefined;
  initialPosition: number;
  introEndTime?: number;
  playbackRate: number;
  handlePlaybackStatusUpdate: (status: any) => void;
  deviceType: string;
  detail?: { poster?: string };
}

export const useVideoHandlers = ({
  videoRef,
  currentEpisode,
  initialPosition,
  introEndTime,
  playbackRate,
  handlePlaybackStatusUpdate,
  deviceType,
  detail,
}: UseVideoHandlersProps) => {
  const vodAdBlockEnabled = useSettingsStore((state) => state.vodAdBlockEnabled);

  useEffect(() => {
    let canceled = false;

    const episodeIdentityUrl = currentEpisode?.rawUrl ?? currentEpisode?.url;
    if (!vodAdBlockEnabled || !episodeIdentityUrl) {
      return () => {
        canceled = true;
      };
    }

    const buildTargets = Array.from(
      new Set([currentEpisode?.rawUrl, currentEpisode?.url].filter((url): url is string => Boolean(url)))
    );

    const prepareFilteredPlaylist = async () => {
      for (const targetUrl of buildTargets) {
        if (!isHttpLiveUrl(targetUrl) || !isM3u8LiveUrl(targetUrl)) {
          continue;
        }

        const filteredUrl = await createDiscontinuityFilteredM3u8Url(targetUrl);
        if (!filteredUrl || canceled) {
          continue;
        }

        const inserted = usePlayerStore
          .getState()
          .prependCurrentEpisodeCandidate(filteredUrl, episodeIdentityUrl);

        if (inserted) {
          logger.info(`[ADBLOCK] Switched to local filtered playlist: ${filteredUrl}`);
          return;
        }
      }
    };

    prepareFilteredPlaylist().catch((error) => {
      logger.warn(`[ADBLOCK] Failed to prepare local filtered playlist: ${episodeIdentityUrl}`);
      logger.warn(error);
    });

    return () => {
      canceled = true;
    };
  }, [currentEpisode?.rawUrl, currentEpisode?.url, vodAdBlockEnabled]);

  const onLoad = useCallback(async () => {
    console.info("[PERF] Video onLoad - video ready to play");

    try {
      const jumpPosition = initialPosition || introEndTime || 0;
      if (jumpPosition > 0) {
        console.info(`[PERF] Setting initial position to ${jumpPosition}ms`);
        await videoRef.current?.setPositionAsync(jumpPosition);
      }

      console.info("[AUTOPLAY] Attempting to start playback after onLoad");
      await videoRef.current?.playAsync();
      console.info("[AUTOPLAY] Auto-play successful after onLoad");

      usePlayerStore.setState({ isLoading: false });
      console.info("[PERF] Video loading complete - isLoading set to false");
    } catch (error) {
      console.warn("[AUTOPLAY] Failed to auto-play after onLoad:", error);
      usePlayerStore.setState({ isLoading: false });
    }
  }, [videoRef, initialPosition, introEndTime]);

  const onLoadStart = useCallback(() => {
    if (!currentEpisode?.url) return;

    console.info(
      `[PERF] Video onLoadStart - starting to load video: ${currentEpisode.url.substring(0, 100)}...`
    );
    usePlayerStore.setState({ isLoading: true });
  }, [currentEpisode?.url]);

  const onError = useCallback(
    (error: any) => {
      if (!currentEpisode?.url) return;

      const playerStore = usePlayerStore.getState();
      const activeEpisode = playerStore.episodes[playerStore.currentEpisodeIndex];

      if (activeEpisode?.url !== currentEpisode.url) {
        console.warn(`[VIDEO_ERROR] Ignore stale error callback for old URL: ${currentEpisode.url}`);
        return;
      }

      if (playerStore.tryFallbackUrl(currentEpisode.url)) {
        Toast.show({
          type: "info",
          text1: "已切换备用线路",
        });
        return;
      }

      console.error("[ERROR] Video playback error:", error);

      const errorString = (error as any)?.error?.toString() || error?.toString() || "";
      const isSSLError =
        errorString.includes("SSLHandshakeException") ||
        errorString.includes("CertPathValidatorException") ||
        errorString.includes("Trust anchor for certification path not found");
      const isNetworkError =
        errorString.includes("HttpDataSourceException") ||
        errorString.includes("IOException") ||
        errorString.includes("SocketTimeoutException");

      if (isSSLError) {
        console.error(`[SSL_ERROR] SSL certificate validation failed for URL: ${currentEpisode.url}`);
        Toast.show({
          type: "error",
          text1: "SSL证书错误，正在切换线路",
          text2: "请稍候",
        });
        usePlayerStore.getState().handleVideoError("ssl", currentEpisode.url);
      } else if (isNetworkError) {
        console.error(`[NETWORK_ERROR] Network connection failed for URL: ${currentEpisode.url}`);
        Toast.show({
          type: "error",
          text1: "网络连接失败，正在切换线路",
          text2: "请稍候",
        });
        usePlayerStore.getState().handleVideoError("network", currentEpisode.url);
      } else {
        console.error(`[VIDEO_ERROR] Other video error for URL: ${currentEpisode.url}`);
        Toast.show({
          type: "error",
          text1: "视频播放失败，正在切换线路",
          text2: "请稍候",
        });
        usePlayerStore.getState().handleVideoError("other", currentEpisode.url);
      }
    },
    [currentEpisode?.url]
  );

  const videoProps = useMemo(
    () => ({
      source: { uri: currentEpisode?.url || "" },
      posterSource: { uri: detail?.poster ?? "" },
      resizeMode: ResizeMode.CONTAIN,
      rate: playbackRate,
      onPlaybackStatusUpdate: handlePlaybackStatusUpdate,
      onLoad,
      onLoadStart,
      onError,
      useNativeControls: deviceType !== "tv",
      shouldPlay: true,
    }),
    [
      currentEpisode?.url,
      detail?.poster,
      playbackRate,
      handlePlaybackStatusUpdate,
      onLoad,
      onLoadStart,
      onError,
      deviceType,
    ]
  );

  return {
    onLoad,
    onLoadStart,
    onError,
    videoProps,
  };
};
