import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, FlatList, StyleSheet, ActivityIndicator, Modal, useTVEventHandler, HWEvent, Text } from "react-native";
import LivePlayer from "@/components/LivePlayer";
import { getPlayableUrl } from "@/services/m3u";
import { ThemedView } from "@/components/ThemedView";
import { StyledButton } from "@/components/StyledButton";
import { useSettingsStore } from "@/stores/settingsStore";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import { api, LiveChannel, LiveSource } from "@/services/api";
import { LiveFavoriteManager } from "@/services/storage";

const FAVORITES_GROUP_NAME = "收藏";

const isSupportedLiveUrl = (url: string) => /^https?:\/\//i.test(url || "");

export default function LiveScreen() {
  const { apiBaseUrl } = useSettingsStore();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  const [liveSources, setLiveSources] = useState<LiveSource[]>([]);
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>("");
  const [channelCache, setChannelCache] = useState<Record<string, LiveChannel[]>>({});
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [groupedChannels, setGroupedChannels] = useState<Record<string, LiveChannel[]>>({});
  const [channelGroups, setChannelGroups] = useState<string[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [favoriteMap, setFavoriteMap] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string>("");

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const getChannelFavoriteId = useCallback((channel: LiveChannel) => channel.tvgId || channel.id, []);

  const applyChannels = useCallback(
    (nextChannels: LiveChannel[], sourceKey: string, nextFavoriteMap: Record<string, boolean>) => {
      setChannels(nextChannels);

      const groups: Record<string, LiveChannel[]> = nextChannels.reduce(
        (acc, channel) => {
          const groupName = channel.group || "Other";
          if (!acc[groupName]) {
            acc[groupName] = [];
          }
          acc[groupName].push(channel);
          return acc;
        },
        {} as Record<string, LiveChannel[]>,
      );

      const favoriteChannels = nextChannels.filter((channel) => {
        const favoriteKey = `${sourceKey}+${getChannelFavoriteId(channel)}`;
        return !!nextFavoriteMap[favoriteKey];
      });
      if (favoriteChannels.length > 0) {
        groups[FAVORITES_GROUP_NAME] = favoriteChannels;
      }

      const groupNames = Object.keys(groups);
      if (groups[FAVORITES_GROUP_NAME]) {
        const index = groupNames.indexOf(FAVORITES_GROUP_NAME);
        if (index > -1) {
          groupNames.splice(index, 1);
          groupNames.unshift(FAVORITES_GROUP_NAME);
        }
      }

      setGroupedChannels(groups);
      setChannelGroups(groupNames);
      setSelectedGroup((prev) => (groupNames.includes(prev) ? prev : groupNames[0] || ""));
      setCurrentChannelIndex(0);

      if (nextChannels.length > 0) {
        showChannelTitle(nextChannels[0].name);
      } else {
        setChannelTitle(null);
      }
    },
    [getChannelFavoriteId],
  );

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex].url) : null;

  const handleRefreshCurrentSource = useCallback(() => {
    if (!selectedSourceKey) {
      return;
    }

    setChannelCache((prev) => {
      const nextCache = { ...prev };
      delete nextCache[selectedSourceKey];
      return nextCache;
    });
  }, [selectedSourceKey]);

  useEffect(() => {
    const loadSources = async () => {
      if (!apiBaseUrl) {
        setLoadError("请先在设置中配置 MoonTV API 地址");
        setLiveSources([]);
        setSelectedSourceKey("");
        setChannelCache({});
        setChannels([]);
        setGroupedChannels({});
        setChannelGroups([]);
        setSelectedGroup("");
        setCurrentChannelIndex(0);
        return;
      }

      setIsLoading(true);
      setLoadError("");

      try {
        const sources = await api.getLiveSources();
        setLiveSources(sources);

        if (sources.length === 0) {
          setLoadError("当前没有可用直播源，请先在 MoonTV 后台配置");
          setSelectedSourceKey("");
          setChannels([]);
          setGroupedChannels({});
          setChannelGroups([]);
          setSelectedGroup("");
          setCurrentChannelIndex(0);
          return;
        }

        const preloadedCache: Record<string, LiveChannel[]> = {};
        let firstPlayableSourceKey = sources[0].key;

        for (const source of sources) {
          try {
            const sourceChannels = await api.getLiveChannels(source.key);
            const supportedChannels = sourceChannels.filter((channel) => isSupportedLiveUrl(channel.url));
            preloadedCache[source.key] = supportedChannels;

            if (supportedChannels.length > 0) {
              firstPlayableSourceKey = source.key;
              break;
            }
          } catch {
            preloadedCache[source.key] = [];
          }
        }

        setChannelCache((prev) => ({
          ...prev,
          ...preloadedCache,
        }));
        setSelectedSourceKey(firstPlayableSourceKey);
      } catch {
        setLoadError("直播源加载失败，请检查网络或登录状态");
      } finally {
        setIsLoading(false);
      }
    };

    loadSources();
  }, [apiBaseUrl]);

  useEffect(() => {
    const loadChannelsBySource = async () => {
      if (!apiBaseUrl || !selectedSourceKey) {
        return;
      }

      setLoadError("");

      const sourceFavorites = await LiveFavoriteManager.getBySource(selectedSourceKey);
      const nextFavoriteMap: Record<string, boolean> = {};
      Object.keys(sourceFavorites).forEach((key) => {
        nextFavoriteMap[key] = true;
      });
      setFavoriteMap(nextFavoriteMap);

      const cachedChannels = channelCache[selectedSourceKey];
      if (cachedChannels) {
        applyChannels(cachedChannels, selectedSourceKey, nextFavoriteMap);
        return;
      }

      setIsLoading(true);
      try {
        const sourceChannels = await api.getLiveChannels(selectedSourceKey);
        const nextChannels = sourceChannels.filter((channel) => isSupportedLiveUrl(channel.url));
        setChannelCache((prev) => ({
          ...prev,
          [selectedSourceKey]: nextChannels,
        }));

        if (sourceChannels.length > 0 && nextChannels.length === 0) {
          setLoadError("当前源为组播/非HTTP链接，设备不支持，请切换其他直播源");
        }

        applyChannels(nextChannels, selectedSourceKey, nextFavoriteMap);
      } catch {
        setLoadError("频道加载失败，请稍后重试");
        setChannels([]);
        setGroupedChannels({});
        setChannelGroups([]);
        setSelectedGroup("");
        setCurrentChannelIndex(0);
      } finally {
        setIsLoading(false);
      }
    };

    loadChannelsBySource();
  }, [apiBaseUrl, selectedSourceKey, channelCache, applyChannels]);

  useEffect(() => {
    return () => {
      if (titleTimer.current) {
        clearTimeout(titleTimer.current);
      }
    };
  }, []);

  const showChannelTitle = (title: string) => {
    setChannelTitle(title);
    if (titleTimer.current) clearTimeout(titleTimer.current);
    titleTimer.current = setTimeout(() => setChannelTitle(null), 3000);
  };

  const handleSelectChannel = (channel: LiveChannel) => {
    const globalIndex = channels.findIndex((c) => c.id === channel.id);
    if (globalIndex !== -1) {
      setCurrentChannelIndex(globalIndex);
      showChannelTitle(channel.name);
      setIsChannelListVisible(false);
    }
  };

  const toggleChannelFavorite = useCallback(
    async (channel: LiveChannel) => {
      if (!selectedSourceKey) {
        return;
      }

      const channelId = getChannelFavoriteId(channel);
      await LiveFavoriteManager.toggle(selectedSourceKey, channelId, {
        source: selectedSourceKey,
        channelId,
        tvgId: channel.tvgId,
        name: channel.name,
        logo: channel.logo,
        group: channel.group,
        url: channel.url,
      });

      const sourceFavorites = await LiveFavoriteManager.getBySource(selectedSourceKey);
      const nextFavoriteMap: Record<string, boolean> = {};
      Object.keys(sourceFavorites).forEach((key) => {
        nextFavoriteMap[key] = true;
      });

      setFavoriteMap(nextFavoriteMap);
      applyChannels(channels, selectedSourceKey, nextFavoriteMap);
    },
    [selectedSourceKey, getChannelFavoriteId, applyChannels, channels],
  );

  const changeChannel = useCallback(
    (direction: "next" | "prev") => {
      if (channels.length === 0) return;
      let newIndex =
        direction === "next"
          ? (currentChannelIndex + 1) % channels.length
          : (currentChannelIndex - 1 + channels.length) % channels.length;
      setCurrentChannelIndex(newIndex);
      showChannelTitle(channels[newIndex].name);
    },
    [channels, currentChannelIndex],
  );

  const handleTVEvent = useCallback(
    (event: HWEvent) => {
      if (deviceType !== "tv") return;
      if (isChannelListVisible) return;
      if (event.eventType === "down") setIsChannelListVisible(true);
      else if (event.eventType === "left") changeChannel("prev");
      else if (event.eventType === "right") changeChannel("next");
    },
    [changeChannel, isChannelListVisible, deviceType],
  );

  useTVEventHandler(deviceType === "tv" ? handleTVEvent : () => {});

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderLiveContent = () => (
    <>
      <LivePlayer streamUrl={selectedChannelUrl} channelTitle={channelTitle} onPlaybackStatusUpdate={() => {}} />
      <Modal
        animationType="slide"
        transparent={true}
        visible={isChannelListVisible}
        onRequestClose={() => setIsChannelListVisible(false)}
      >
        <View style={dynamicStyles.modalContainer}>
          <View style={dynamicStyles.modalContent}>
            <Text style={dynamicStyles.modalTitle}>选择频道</Text>
            <Text style={dynamicStyles.modalHint}>按下播放，长按收藏频道</Text>
            <View style={dynamicStyles.sourceContainer}>
              <FlatList
                data={liveSources}
                horizontal
                keyExtractor={(item) => `source-${item.key}`}
                renderItem={({ item }) => (
                  <StyledButton
                    text={item.name}
                    onPress={() => setSelectedSourceKey(item.key)}
                    isSelected={selectedSourceKey === item.key}
                    style={dynamicStyles.sourceButton}
                    textStyle={dynamicStyles.sourceButtonText}
                  />
                )}
              />
              <StyledButton
                text="刷新"
                onPress={handleRefreshCurrentSource}
                style={dynamicStyles.refreshButton}
                textStyle={dynamicStyles.refreshButtonText}
              />
            </View>
            {!!loadError && <Text style={dynamicStyles.errorText}>{loadError}</Text>}
            <View style={dynamicStyles.listContainer}>
              <View style={dynamicStyles.groupColumn}>
                <FlatList
                  data={channelGroups}
                  keyExtractor={(item, index) => `group-${item}-${index}`}
                  renderItem={({ item }) => (
                    <StyledButton
                      text={item}
                      onPress={() => setSelectedGroup(item)}
                      isSelected={selectedGroup === item}
                      style={dynamicStyles.groupButton}
                      textStyle={dynamicStyles.groupButtonText}
                    />
                  )}
                />
              </View>
              <View style={dynamicStyles.channelColumn}>
                {isLoading ? (
                  <ActivityIndicator size="large" />
                ) : (groupedChannels[selectedGroup] || []).length === 0 ? (
                  <Text style={dynamicStyles.emptyText}>当前分组暂无频道</Text>
                ) : (
                  <FlatList
                    data={groupedChannels[selectedGroup] || []}
                    keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                    renderItem={({ item }) => (
                      <StyledButton
                        text={`${favoriteMap[`${selectedSourceKey}+${getChannelFavoriteId(item)}`] ? "★ " : ""}${item.name || "Unknown Channel"}`}
                        onPress={() => handleSelectChannel(item)}
                        onLongPress={() => toggleChannelFavorite(item)}
                        isSelected={channels[currentChannelIndex]?.id === item.id}
                        hasTVPreferredFocus={channels[currentChannelIndex]?.id === item.id}
                        style={dynamicStyles.channelItem}
                        textStyle={dynamicStyles.channelItemText}
                      />
                    )}
                  />
                )}
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>{renderLiveContent()}</ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === "tv") {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="直播" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === "mobile";
  const isTablet = deviceType === "tablet";
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
    },
    modalContainer: {
      flex: 1,
      flexDirection: "row",
      justifyContent: isMobile ? "center" : "flex-end",
      backgroundColor: "transparent",
    },
    modalContent: {
      width: isMobile ? "90%" : isTablet ? 400 : 450,
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      padding: spacing,
    },
    modalTitle: {
      color: "white",
      marginBottom: spacing / 2,
      textAlign: "center",
      fontSize: isMobile ? 18 : 16,
      fontWeight: "bold",
    },
    sourceContainer: {
      marginBottom: spacing / 2,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    modalHint: {
      color: "rgba(255, 255, 255, 0.75)",
      fontSize: isMobile ? 13 : 12,
      textAlign: "center",
      marginBottom: spacing / 2,
    },
    sourceButton: {
      marginRight: 8,
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing / 2,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    sourceButtonText: {
      fontSize: isMobile ? 14 : 12,
    },
    refreshButton: {
      marginLeft: spacing / 2,
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing / 2,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    refreshButtonText: {
      fontSize: isMobile ? 14 : 12,
    },
    errorText: {
      color: "#ff8f8f",
      fontSize: isMobile ? 13 : 12,
      marginBottom: spacing / 2,
      textAlign: "center",
    },
    emptyText: {
      color: "rgba(255, 255, 255, 0.8)",
      fontSize: isMobile ? 13 : 12,
      textAlign: "center",
      marginTop: spacing,
    },
    listContainer: {
      flex: 1,
      flexDirection: isMobile ? "column" : "row",
    },
    groupColumn: {
      flex: isMobile ? 0 : 1,
      marginRight: isMobile ? 0 : spacing / 2,
      marginBottom: isMobile ? spacing : 0,
      maxHeight: isMobile ? 120 : undefined,
    },
    channelColumn: {
      flex: isMobile ? 1 : 2,
    },
    groupButton: {
      paddingVertical: isMobile ? minTouchTarget / 4 : 8,
      paddingHorizontal: spacing / 2,
      marginVertical: isMobile ? 2 : 4,
      minHeight: isMobile ? minTouchTarget * 0.7 : undefined,
    },
    groupButtonText: {
      fontSize: isMobile ? 14 : 13,
    },
    channelItem: {
      paddingVertical: isMobile ? minTouchTarget / 5 : 6,
      paddingHorizontal: spacing,
      marginVertical: isMobile ? 2 : 3,
      minHeight: isMobile ? minTouchTarget * 0.8 : undefined,
    },
    channelItemText: {
      fontSize: isMobile ? 14 : 12,
    },
  });
};
