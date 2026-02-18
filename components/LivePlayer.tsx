import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, StyleSheet, Text, ActivityIndicator } from "react-native";
import { Video, ResizeMode, AVPlaybackStatus } from "expo-av";
import { useKeepAwake } from "expo-keep-awake";

interface LivePlayerProps {
  streamUrl: string | null;
  fallbackStreamUrl?: string | null;
  channelTitle?: string | null;
  onPlaybackStatusUpdate: (status: AVPlaybackStatus) => void;
}

const PLAYBACK_TIMEOUT = 15000; // 15 seconds

export default function LivePlayer({
  streamUrl,
  fallbackStreamUrl = null,
  channelTitle,
  onPlaybackStatusUpdate,
}: LivePlayerProps) {
  const video = useRef<Video>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTimeout, setIsTimeout] = useState(false);
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasSwitchedRef = useRef(false);
  const fallbackStreamUrlRef = useRef<string | null>(null);
  useKeepAwake();

  const startTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      if (!hasSwitchedRef.current && fallbackStreamUrlRef.current) {
        hasSwitchedRef.current = true;
        setHasSwitchedToFallback(true);
        setActiveStreamUrl(fallbackStreamUrlRef.current);
        setStatusMessage("去广告线路失败，已切换直连...");
        setIsLoading(true);
        setIsTimeout(false);
        startTimeout();
        return;
      }

      setIsTimeout(true);
      setIsLoading(false);
      setStatusMessage(null);
    }, PLAYBACK_TIMEOUT);
  }, []);

  const switchToFallback = useCallback(() => {
    if (!hasSwitchedRef.current && fallbackStreamUrlRef.current) {
      hasSwitchedRef.current = true;
      setActiveStreamUrl(fallbackStreamUrlRef.current);
      setStatusMessage("去广告线路失败，已切换直连...");
      setIsLoading(true);
      setIsTimeout(false);
      startTimeout();
      return true;
    }
    return false;
  }, [startTimeout]);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    if (streamUrl) {
      fallbackStreamUrlRef.current = fallbackStreamUrl;
      hasSwitchedRef.current = false;
      setActiveStreamUrl(streamUrl);
      setIsLoading(true);
      setIsTimeout(false);
      setStatusMessage(null);
      startTimeout();
    } else {
      fallbackStreamUrlRef.current = null;
      hasSwitchedRef.current = false;
      setActiveStreamUrl(null);
      setIsLoading(false);
      setIsTimeout(false);
      setStatusMessage(null);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [streamUrl, fallbackStreamUrl, startTimeout]);

  const handlePlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (status.isLoaded) {
      if (status.isPlaying) {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        setIsLoading(false);
        setIsTimeout(false);
        setStatusMessage(hasSwitchedRef.current ? "当前为直连线路" : null);
      } else if (status.isBuffering) {
        setIsLoading(true);
      }
    } else {
      if (status.error) {
        if (!switchToFallback()) {
          setIsLoading(false);
          setIsTimeout(true);
          setStatusMessage(null);
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
          }
        }
      }
    }
    onPlaybackStatusUpdate(status);
  };

  if (!activeStreamUrl) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>按向下键选择频道</Text>
      </View>
    );
  }

  if (isTimeout) {
    return (
      <View style={styles.container}>
        <Text style={styles.messageText}>加载失败，请重试</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Video
        ref={video}
        style={styles.video}
        source={{
          uri: activeStreamUrl,
        }}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay
        onPlaybackStatusUpdate={handlePlaybackStatusUpdate}
        onError={(e) => {
          if (!switchToFallback()) {
            setIsTimeout(true);
            setIsLoading(false);
            setStatusMessage(null);
          }
        }}
      />
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.messageText}>{statusMessage || "加载中..."}</Text>
        </View>
      )}
      {statusMessage && !isLoading && !isTimeout && (
        <View style={styles.statusOverlay}>
          <Text style={styles.statusText}>{statusMessage}</Text>
        </View>
      )}
      {channelTitle && !isLoading && !isTimeout && (
        <View style={styles.overlay}>
          <Text style={styles.title}>{channelTitle}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  video: {
    flex: 1,
    alignSelf: "stretch",
  },
  overlay: {
    position: "absolute",
    top: 20,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    padding: 10,
    borderRadius: 5,
  },
  title: {
    color: "#fff",
    fontSize: 18,
  },
  messageText: {
    color: "#fff",
    fontSize: 16,
    marginTop: 10,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  statusOverlay: {
    position: "absolute",
    bottom: 24,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 5,
  },
  statusText: {
    color: "#cceeff",
    fontSize: 12,
  },
});
