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

  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isChannelListVisible, setIsChannelListVisible] = useState(false);
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  const titleTimer = useRef<NodeJS.Timeout | null>(null);

  const applyChannels = useCallback((nextChannels: LiveChannel[]) => {
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

    const groupNames = Object.keys(groups);
    setGroupedChannels(groups);
    setChannelGroups(groupNames);
    setSelectedGroup(groupNames[0] || "");
    setCurrentChannelIndex(0);

    if (nextChannels.length > 0) {
      showChannelTitle(nextChannels[0].name);
    } else {
      setChannelTitle(null);
    }
  }, []);

  const selectedChannelUrl = channels.length > 0 ? getPlayableUrl(channels[currentChannelIndex].url) : null;

  useEffect(() => {
    const loadSources = async () => {
      if (!apiBaseUrl) {
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

      try {
        const sources = await api.getLiveSources();
        setLiveSources(sources);

        if (sources.length === 0) {
          setSelectedSourceKey("");
          setChannels([]);
          setGroupedChannels({});
          setChannelGroups([]);
          setSelectedGroup("");
          setCurrentChannelIndex(0);
          return;
        }

        setSelectedSourceKey((prev) => {
          if (prev && sources.some((source) => source.key === prev)) {
            return prev;
          }
          return sources[0].key;
        });
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

      const cachedChannels = channelCache[selectedSourceKey];
      if (cachedChannels) {
        applyChannels(cachedChannels);
        return;
      }

      setIsLoading(true);
      try {
        const nextChannels = await api.getLiveChannels(selectedSourceKey);
        setChannelCache((prev) => ({
          ...prev,
          [selectedSourceKey]: nextChannels,
        }));
        applyChannels(nextChannels);
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
            </View>
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
                ) : (
                  <FlatList
                    data={groupedChannels[selectedGroup] || []}
                    keyExtractor={(item, index) => `${item.id}-${item.group}-${index}`}
                    renderItem={({ item }) => (
                      <StyledButton
                        text={item.name || "Unknown Channel"}
                        onPress={() => handleSelectChannel(item)}
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
