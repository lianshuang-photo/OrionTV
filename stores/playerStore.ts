import { create } from "zustand";
import Toast from "react-native-toast-message";
import { AVPlaybackStatus, Video } from "expo-av";
import { RefObject } from "react";
import { PlayRecord, PlayRecordManager, PlayerSettingsManager } from "@/services/storage";
import { getPlaybackUrlCandidates } from "@/services/m3u";
import { useSettingsStore } from "@/stores/settingsStore";
import useDetailStore, { episodesSelectorBySource } from "./detailStore";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("PlayerStore");

const getEpisodeTitle = (index: number) => `Episode ${index + 1}`;

const mapEpisodesForPlayback = (episodeUrls: string[], sourceKey: string) => {
  const { apiBaseUrl, vodAdBlockEnabled } = useSettingsStore.getState();

  return episodeUrls.map((episodeUrl, index) => {
    const playbackCandidates = getPlaybackUrlCandidates(episodeUrl, apiBaseUrl, sourceKey, vodAdBlockEnabled);

    const uniqueCandidates = Array.from(
      new Set(
        [...(playbackCandidates.length > 0 ? playbackCandidates : []), episodeUrl].filter(
          (candidate): candidate is string => Boolean(candidate)
        )
      )
    );

    return {
      url: uniqueCandidates[0] || episodeUrl,
      rawUrl: episodeUrl,
      title: getEpisodeTitle(index),
      urlCandidates: uniqueCandidates,
      currentCandidateIndex: 0,
    };
  });
};

interface Episode {
  url: string;
  rawUrl: string;
  title: string;
  urlCandidates: string[];
  currentCandidateIndex: number;
}

interface PlayerState {
  videoRef: RefObject<Video> | null;
  currentEpisodeIndex: number;
  episodes: Episode[];
  status: AVPlaybackStatus | null;
  isLoading: boolean;
  showControls: boolean;
  showEpisodeModal: boolean;
  showSourceModal: boolean;
  showSpeedModal: boolean;
  showNextEpisodeOverlay: boolean;
  isSeeking: boolean;
  seekPosition: number;
  progressPosition: number;
  initialPosition: number;
  playbackRate: number;
  introEndTime?: number;
  outroStartTime?: number;
  setVideoRef: (ref: RefObject<Video>) => void;
  loadVideo: (options: {
    source: string;
    id: string;
    title: string;
    episodeIndex: number;
    position?: number;
  }) => Promise<void>;
  playEpisode: (index: number) => void;
  togglePlayPause: () => void;
  seek: (duration: number) => void;
  handlePlaybackStatusUpdate: (newStatus: AVPlaybackStatus) => void;
  setLoading: (loading: boolean) => void;
  setShowControls: (show: boolean) => void;
  setShowEpisodeModal: (show: boolean) => void;
  setShowSourceModal: (show: boolean) => void;
  setShowSpeedModal: (show: boolean) => void;
  setShowNextEpisodeOverlay: (show: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setIntroEndTime: () => void;
  setOutroStartTime: () => void;
  refreshEpisodeUrls: () => void;
  prependCurrentEpisodeCandidate: (candidateUrl: string, originalUrl?: string) => boolean;
  tryFallbackUrl: (failedUrl: string) => boolean;
  reset: () => void;
  _seekTimeout?: NodeJS.Timeout;
  _isRecordSaveThrottled: boolean;
  // Internal helper
  _savePlayRecord: (updates?: Partial<PlayRecord>, options?: { immediate?: boolean }) => void;
  handleVideoError: (errorType: "ssl" | "network" | "other", failedUrl: string) => Promise<void>;
}

const usePlayerStore = create<PlayerState>((set, get) => ({
  videoRef: null,
  episodes: [],
  currentEpisodeIndex: -1,
  status: null,
  isLoading: true,
  showControls: false,
  showEpisodeModal: false,
  showSourceModal: false,
  showSpeedModal: false,
  showNextEpisodeOverlay: false,
  isSeeking: false,
  seekPosition: 0,
  progressPosition: 0,
  initialPosition: 0,
  playbackRate: 1.0,
  introEndTime: undefined,
  outroStartTime: undefined,
  _seekTimeout: undefined,
  _isRecordSaveThrottled: false,

  setVideoRef: (ref) => set({ videoRef: ref }),

  loadVideo: async ({ source, id, episodeIndex, position, title }) => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayerStore.loadVideo START - source: ${source}, id: ${id}, title: ${title}`);

    let detail = useDetailStore.getState().detail;
    let episodes: string[] = [];

    // If detail exists, use detail.source; otherwise use provided source.
    if (detail && detail.source) {
      logger.info(`[INFO] Using existing detail source "${detail.source}" to get episodes`);
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    } else {
      logger.info(`[INFO] No existing detail, using provided source "${source}" to get episodes`);
      episodes = episodesSelectorBySource(source)(useDetailStore.getState());
    }

    set({
      isLoading: true,
    });

    const needsDetailInit = !detail || !episodes || episodes.length === 0 || detail.title !== title;
    logger.info(
      `[PERF] Detail check - needsInit: ${needsDetailInit}, hasDetail: ${!!detail}, episodesCount: ${
        episodes?.length || 0
      }`
    );

    if (needsDetailInit) {
      const detailInitStart = performance.now();
      logger.info(`[PERF] DetailStore.init START - ${title}`);

      await useDetailStore.getState().init(title, source, id);

      const detailInitEnd = performance.now();
      logger.info(`[PERF] DetailStore.init END - took ${(detailInitEnd - detailInitStart).toFixed(2)}ms`);

      detail = useDetailStore.getState().detail;

      if (!detail) {
        logger.error(`[ERROR] Detail not found after initialization for "${title}" (source: ${source}, id: ${id})`);

        // Check DetailStore error state.
        const detailStoreState = useDetailStore.getState();
        if (detailStoreState.error) {
          logger.error(`[ERROR] DetailStore error: ${detailStoreState.error}`);
          set({
            isLoading: false,
            // PlayerStore has no dedicated error field.
          });
        } else {
          logger.error(`[ERROR] DetailStore init completed but no detail found and no error reported`);
          set({ isLoading: false });
        }
        return;
      }

      // Use actual source selected by DetailStore.
      logger.info(`[INFO] Using actual source "${detail.source}" instead of preferred source "${source}"`);
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());

      if (!episodes || episodes.length === 0) {
        logger.error(`[ERROR] No episodes found for "${title}" from source "${detail.source}" (${detail.source_name})`);

        // Try to read episodes from searchResults.
        const detailStoreState = useDetailStore.getState();
        logger.info(
          `[INFO] Available sources in searchResults: ${detailStoreState.searchResults
            .map((r) => `${r.source}(${r.episodes?.length || 0} episodes)`)
            .join(", ")}`
        );

        // If current source has no episodes, fallback to first source with episodes.
        const sourceWithEpisodes = detailStoreState.searchResults.find((r) => r.episodes && r.episodes.length > 0);
        if (sourceWithEpisodes) {
          logger.info(
            `[FALLBACK] Using alternative source "${sourceWithEpisodes.source}" with ${sourceWithEpisodes.episodes.length} episodes`
          );
          episodes = sourceWithEpisodes.episodes;
          // Switch detail to source that has episodes.
          detail = sourceWithEpisodes;
        } else {
          logger.error(`[ERROR] No source with episodes found in searchResults`);
          set({ isLoading: false });
          return;
        }
      }

      logger.info(`[SUCCESS] Detail and episodes loaded - source: ${detail.source_name}, episodes: ${episodes.length}`);
    } else {
      logger.info(`[PERF] Skipping DetailStore.init - using cached data`);

      // Even with cached data, ensure episodes are loaded from the right source.
      if (detail && detail.source && detail.source !== source) {
        logger.info(
          `[INFO] Cached detail source "${detail.source}" differs from provided source "${source}", updating episodes`
        );
        episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());

        if (!episodes || episodes.length === 0) {
          logger.warn(
            `[WARN] Cached detail source "${detail.source}" has no episodes, trying provided source "${source}"`
          );
          episodes = episodesSelectorBySource(source)(useDetailStore.getState());
        }
      }
    }

    // Final validation.
    if (!detail) {
      logger.error(`[ERROR] Final check failed: detail is null`);
      set({ isLoading: false });
      return;
    }

    if (!episodes || episodes.length === 0) {
      logger.error(
        `[ERROR] Final check failed: no episodes available for source "${detail.source}" (${detail.source_name})`
      );
      set({ isLoading: false });
      return;
    }

    logger.info(`[SUCCESS] Final validation passed - detail: ${detail.source_name}, episodes: ${episodes.length}`);

    try {
      const storageStart = performance.now();
      logger.info(`[PERF] Storage operations START`);

      const playRecord = await PlayRecordManager.get(detail!.source, detail!.id.toString());
      const storagePlayRecordEnd = performance.now();
      logger.info(`[PERF] PlayRecordManager.get took ${(storagePlayRecordEnd - storageStart).toFixed(2)}ms`);

      const playerSettings = await PlayerSettingsManager.get(detail!.source, detail!.id.toString());
      const storageEnd = performance.now();
      logger.info(`[PERF] PlayerSettingsManager.get took ${(storageEnd - storagePlayRecordEnd).toFixed(2)}ms`);
      logger.info(`[PERF] Total storage operations took ${(storageEnd - storageStart).toFixed(2)}ms`);

      const initialPositionFromRecord = playRecord?.play_time ? playRecord.play_time * 1000 : 0;
      const savedPlaybackRate = playerSettings?.playbackRate || 1.0;

      const episodesMappingStart = performance.now();
      const mappedEpisodes = mapEpisodesForPlayback(episodes, detail.source);
      const episodesMappingEnd = performance.now();
      logger.info(
        `[PERF] Episodes mapping (${episodes.length} episodes) took ${(
          episodesMappingEnd - episodesMappingStart
        ).toFixed(2)}ms`
      );

      set({
        isLoading: false,
        currentEpisodeIndex: episodeIndex,
        initialPosition: position || initialPositionFromRecord,
        playbackRate: savedPlaybackRate,
        episodes: mappedEpisodes,
        introEndTime: playRecord?.introEndTime || playerSettings?.introEndTime,
        outroStartTime: playRecord?.outroStartTime || playerSettings?.outroStartTime,
      });

      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    } catch (error) {
      logger.debug("Failed to load play record", error);
      set({ isLoading: false });

      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo ERROR - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  playEpisode: async (index) => {
    const { episodes, videoRef } = get();
    if (index >= 0 && index < episodes.length) {
      set({
        currentEpisodeIndex: index,
        showNextEpisodeOverlay: false,
        initialPosition: 0,
        progressPosition: 0,
        seekPosition: 0,
      });
      try {
        await videoRef?.current?.replayAsync();
      } catch (error) {
        logger.debug("Failed to replay video:", error);
        Toast.show({ type: "error", text1: "播放失败" });
      }
    }
  },

  togglePlayPause: async () => {
    const { status, videoRef } = get();
    if (status?.isLoaded) {
      try {
        if (status.isPlaying) {
          await videoRef?.current?.pauseAsync();
        } else {
          await videoRef?.current?.playAsync();
        }
      } catch (error) {
        logger.debug("Failed to toggle play/pause:", error);
        Toast.show({ type: "error", text1: "操作失败" });
      }
    }
  },

  seek: async (duration) => {
    const { status, videoRef } = get();
    if (!status?.isLoaded || !status.durationMillis) return;

    const newPosition = Math.max(0, Math.min(status.positionMillis + duration, status.durationMillis));
    try {
      await videoRef?.current?.setPositionAsync(newPosition);
    } catch (error) {
      logger.debug("Failed to seek video:", error);
      Toast.show({ type: "error", text1: "快进/快退失败" });
    }

    set({
      isSeeking: true,
      seekPosition: newPosition / status.durationMillis,
    });

    if (get()._seekTimeout) {
      clearTimeout(get()._seekTimeout);
    }
    const timeoutId = setTimeout(() => set({ isSeeking: false }), 1000);
    set({ _seekTimeout: timeoutId });
  },

  setIntroEndTime: () => {
    const { status, introEndTime: existingIntroEndTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingIntroEndTime) {
      // Clear the time
      set({ introEndTime: undefined });
      get()._savePlayRecord({ introEndTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片头时间",
      });
    } else {
      // Set the time
      const newIntroEndTime = status.positionMillis;
      set({ introEndTime: newIntroEndTime });
      get()._savePlayRecord({ introEndTime: newIntroEndTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片头时间已记录",
      });
    }
  },

  setOutroStartTime: () => {
    const { status, outroStartTime: existingOutroStartTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingOutroStartTime) {
      // Clear the time
      set({ outroStartTime: undefined });
      get()._savePlayRecord({ outroStartTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片尾时间",
      });
    } else {
      // Set the time
      if (!status.durationMillis) return;
      const newOutroStartTime = status.durationMillis - status.positionMillis;
      set({ outroStartTime: newOutroStartTime });
      get()._savePlayRecord({ outroStartTime: newOutroStartTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片尾时间已记录",
      });
    }
  },

  _savePlayRecord: (updates = {}, options = {}) => {
    const { immediate = false } = options;
    if (!immediate) {
      if (get()._isRecordSaveThrottled) {
        return;
      }
      set({ _isRecordSaveThrottled: true });
      setTimeout(() => {
        set({ _isRecordSaveThrottled: false });
      }, 10000); // 10 seconds
    }

    const { detail } = useDetailStore.getState();
    const { currentEpisodeIndex, episodes, status, introEndTime, outroStartTime } = get();
    if (detail && status?.isLoaded) {
      const existingRecord = {
        introEndTime,
        outroStartTime,
      };
      PlayRecordManager.save(detail.source, detail.id.toString(), {
        title: detail.title,
        cover: detail.poster || "",
        index: currentEpisodeIndex + 1,
        total_episodes: episodes.length,
        play_time: Math.floor(status.positionMillis / 1000),
        total_time: status.durationMillis ? Math.floor(status.durationMillis / 1000) : 0,
        source_name: detail.source_name,
        year: detail.year || "",
        ...existingRecord,
        ...updates,
      });
    }
  },

  handlePlaybackStatusUpdate: (newStatus) => {
    if (!newStatus.isLoaded) {
      if (newStatus.error) {
        logger.debug(`Playback Error: ${newStatus.error}`);
      }
      set({ status: newStatus });
      return;
    }

    const { currentEpisodeIndex, episodes, outroStartTime, playEpisode } = get();
    const detail = useDetailStore.getState().detail;

    if (
      outroStartTime &&
      newStatus.durationMillis &&
      newStatus.positionMillis >= newStatus.durationMillis - outroStartTime
    ) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
        return; // Stop further processing for this update
      }
    }

    if (detail && newStatus.durationMillis) {
      get()._savePlayRecord();

      const isNearEnd = newStatus.positionMillis / newStatus.durationMillis > 0.95;
      if (isNearEnd && currentEpisodeIndex < episodes.length - 1 && !outroStartTime) {
        set({ showNextEpisodeOverlay: true });
      } else {
        set({ showNextEpisodeOverlay: false });
      }
    }

    if (newStatus.didJustFinish) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
      }
    }

    const progressPosition = newStatus.durationMillis ? newStatus.positionMillis / newStatus.durationMillis : 0;
    set({ status: newStatus, progressPosition });
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setShowControls: (show) => set({ showControls: show }),
  setShowEpisodeModal: (show) => set({ showEpisodeModal: show }),
  setShowSourceModal: (show) => set({ showSourceModal: show }),
  setShowSpeedModal: (show) => set({ showSpeedModal: show }),
  setShowNextEpisodeOverlay: (show) => set({ showNextEpisodeOverlay: show }),

  setPlaybackRate: async (rate) => {
    const { videoRef } = get();
    const detail = useDetailStore.getState().detail;

    try {
      await videoRef?.current?.setRateAsync(rate, true);
      set({ playbackRate: rate });

      // Save the playback rate preference
      if (detail) {
        await PlayerSettingsManager.save(detail.source, detail.id.toString(), { playbackRate: rate });
      }
    } catch (error) {
      logger.debug("Failed to set playback rate:", error);
    }
  },

  refreshEpisodeUrls: () => {
    const detail = useDetailStore.getState().detail;
    const { currentEpisodeIndex } = get();
    if (!detail) {
      return;
    }

    const sourceEpisodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    if (!sourceEpisodes.length) {
      return;
    }

    const mappedEpisodes = mapEpisodesForPlayback(sourceEpisodes, detail.source);
    const safeEpisodeIndex = Math.max(0, Math.min(currentEpisodeIndex, mappedEpisodes.length - 1));

    set({
      episodes: mappedEpisodes,
      currentEpisodeIndex: safeEpisodeIndex,
    });
  },

  prependCurrentEpisodeCandidate: (candidateUrl: string, originalUrl) => {
    if (!candidateUrl) {
      return false;
    }

    const { currentEpisodeIndex, episodes } = get();
    const currentEpisode = episodes[currentEpisodeIndex];

    if (!currentEpisode) {
      return false;
    }

    if (originalUrl && currentEpisode.rawUrl && currentEpisode.rawUrl !== originalUrl) {
      return false;
    }

    if (currentEpisode.urlCandidates[0] === candidateUrl && currentEpisode.url === candidateUrl) {
      return false;
    }

    const nextCandidates = [candidateUrl, ...currentEpisode.urlCandidates.filter((url) => url !== candidateUrl)];

    const nextEpisodes = [...episodes];
    nextEpisodes[currentEpisodeIndex] = {
      ...currentEpisode,
      url: candidateUrl,
      urlCandidates: nextCandidates,
      currentCandidateIndex: 0,
    };

    set({
      episodes: nextEpisodes,
      isLoading: false,
    });

    logger.info("[ADBLOCK] Injected local filtered playlist for current episode");

    return true;
  },

  tryFallbackUrl: (failedUrl: string) => {
    const { currentEpisodeIndex, episodes } = get();
    const currentEpisode = episodes[currentEpisodeIndex];

    if (!currentEpisode || !failedUrl || currentEpisode.url !== failedUrl) {
      return false;
    }

    const nextCandidateIndex = currentEpisode.currentCandidateIndex + 1;
    const nextCandidateUrl = currentEpisode.urlCandidates[nextCandidateIndex];

    if (!nextCandidateUrl) {
      return false;
    }

    const nextEpisodes = [...episodes];
    nextEpisodes[currentEpisodeIndex] = {
      ...currentEpisode,
      url: nextCandidateUrl,
      currentCandidateIndex: nextCandidateIndex,
    };

    set({
      episodes: nextEpisodes,
      isLoading: false,
    });

    logger.warn(
      `[VIDEO_FALLBACK] Switching episode ${currentEpisodeIndex + 1} url candidate ${nextCandidateIndex + 1}/${
        currentEpisode.urlCandidates.length
      }`
    );

    return true;
  },

  reset: () => {
    set({
      episodes: [],
      currentEpisodeIndex: 0,
      status: null,
      isLoading: true,
      showControls: false,
      showEpisodeModal: false,
      showSourceModal: false,
      showSpeedModal: false,
      showNextEpisodeOverlay: false,
      initialPosition: 0,
      playbackRate: 1.0,
      introEndTime: undefined,
      outroStartTime: undefined,
    });
  },

  handleVideoError: async (errorType: "ssl" | "network" | "other", failedUrl: string) => {
    const perfStart = performance.now();
    logger.error(`[VIDEO_ERROR] Handling ${errorType} error for URL: ${failedUrl}`);

    const detailStoreState = useDetailStore.getState();
    const { detail } = detailStoreState;
    const { currentEpisodeIndex } = get();

    if (!detail) {
      logger.error(`[VIDEO_ERROR] Cannot fallback - no detail available`);
      set({ isLoading: false });
      return;
    }

    // Mark current source as failed.
    const currentSource = detail.source;
    const errorReason = `${errorType} error: ${failedUrl.substring(0, 100)}...`;
    useDetailStore.getState().markSourceAsFailed(currentSource, errorReason);

    // Get next available source.
    const fallbackSource = useDetailStore.getState().getNextAvailableSource(currentSource, currentEpisodeIndex);

    if (!fallbackSource) {
      logger.error(`[VIDEO_ERROR] No fallback sources available for episode ${currentEpisodeIndex + 1}`);
      Toast.show({
        type: "error",
        text1: "播放失败",
        text2: "所有播放源都不可用，请稍后重试",
      });
      set({ isLoading: false });
      return;
    }

    logger.info(`[VIDEO_ERROR] Switching to fallback source: ${fallbackSource.source} (${fallbackSource.source_name})`);

    try {
      // Update DetailStore with fallback source.
      await useDetailStore.getState().setDetail(fallbackSource);

      // Reload episodes for current index.
      const newEpisodes = fallbackSource.episodes || [];
      if (newEpisodes.length > currentEpisodeIndex) {
        const mappedEpisodes = mapEpisodesForPlayback(newEpisodes, fallbackSource.source);

        set({
          episodes: mappedEpisodes,
          isLoading: false,
        });

        const perfEnd = performance.now();
        logger.info(`[VIDEO_ERROR] Successfully switched to fallback source in ${(perfEnd - perfStart).toFixed(2)}ms`);
        logger.info(`[VIDEO_ERROR] New episode URL: ${newEpisodes[currentEpisodeIndex].substring(0, 100)}...`);

        Toast.show({
          type: "success",
          text1: "已切换播放源",
          text2: `正在使用 ${fallbackSource.source_name}`,
        });
      } else {
        logger.error(`[VIDEO_ERROR] Fallback source doesn't have episode ${currentEpisodeIndex + 1}`);
        set({ isLoading: false });
      }
    } catch (error) {
      logger.error(`[VIDEO_ERROR] Failed to switch to fallback source:`, error);
      set({ isLoading: false });
    }
  },
}));

export default usePlayerStore;

export const selectCurrentEpisode = (state: PlayerState) => {
  // Safer data checks.
  if (
    state.episodes &&
    Array.isArray(state.episodes) &&
    state.episodes.length > 0 &&
    state.currentEpisodeIndex >= 0 &&
    state.currentEpisodeIndex < state.episodes.length
  ) {
    const episode = state.episodes[state.currentEpisodeIndex];
    // 纭繚episode鏈夋湁鏁堢殑URL
    if (episode && episode.url && episode.url.trim() !== "") {
      return episode;
    } else {
      // Debug only.
      if (__DEV__) {
        logger.debug(`[PERF] selectCurrentEpisode - episode found but invalid URL: ${episode?.url}`);
      }
    }
  } else {
    // Debug only.
    if (__DEV__) {
      logger.debug(
        `[PERF] selectCurrentEpisode - no valid episode: episodes.length=${state.episodes?.length}, currentIndex=${state.currentEpisodeIndex}`
      );
    }
  }
  return undefined;
};
