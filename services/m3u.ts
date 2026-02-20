import * as FileSystem from "expo-file-system";
import Logger from "@/utils/Logger";

const logger = Logger.withTag("M3U");

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
}

const AD_MARKER_TAGS = [
  "#EXT-X-DISCONTINUITY",
  "#EXT-X-CUE-OUT",
  "#EXT-X-CUE-IN",
  "#EXT-OATCLS-SCTE35",
  "#EXT-X-SCTE35",
];

const FILTER_CACHE_DIR = `${FileSystem.cacheDirectory}ad-filtered-m3u8/`;
const filteredPlaylistCache = new Map<string, string>();

export const parseM3U = (m3uText: string): Channel[] => {
  const parsedChannels: Channel[] = [];
  const lines = m3uText.split("\n");
  let currentChannelInfo: Partial<Channel> | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("#EXTINF:")) {
      currentChannelInfo = {};
      const commaIndex = trimmedLine.lastIndexOf(",");
      if (commaIndex !== -1) {
        currentChannelInfo.name = trimmedLine.substring(commaIndex + 1).trim();
        const attributesPart = trimmedLine.substring(8, commaIndex);
        const logoMatch = attributesPart.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch && logoMatch[1]) {
          currentChannelInfo.logo = logoMatch[1];
        }
        const groupMatch = attributesPart.match(/group-title="([^"]*)"/i);
        if (groupMatch && groupMatch[1]) {
          currentChannelInfo.group = groupMatch[1];
        }
      } else {
        currentChannelInfo.name = trimmedLine.substring(8).trim();
      }
    } else if (currentChannelInfo && trimmedLine && !trimmedLine.startsWith("#") && trimmedLine.includes("://")) {
      currentChannelInfo.url = trimmedLine;
      currentChannelInfo.id = currentChannelInfo.url;

      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || "Unknown",
        logo: currentChannelInfo.logo || "",
        group: currentChannelInfo.group || "Default",
      };

      parsedChannels.push(finalChannel);
      currentChannelInfo = null;
    }
  }
  return parsedChannels;
};

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  try {
    const response = await fetch(m3uUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    const m3uText = await response.text();
    return parseM3U(m3uText);
  } catch (error) {
    logger.info("Error fetching or parsing M3U:", error);
    return [];
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  return originalUrl;
};

export const isHttpLiveUrl = (url: string | null): boolean => {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
};

export const isM3u8LiveUrl = (url: string | null): boolean => {
  if (!url) return false;
  return /\.m3u8($|\?)/i.test(url);
};

const normalizeApiBaseUrl = (apiBaseUrl: string) => apiBaseUrl.replace(/\/$/, "");

const resolveUrl = (baseUrl: string, inputUrl: string) => {
  try {
    return new URL(inputUrl, baseUrl).toString();
  } catch {
    return inputUrl;
  }
};

const rewriteUriAttribute = (line: string, baseUrl: string) =>
  line.replace(/URI="([^"]+)"/g, (_, uriValue: string) => `URI="${resolveUrl(baseUrl, uriValue)}"`);

const shouldFilterTag = (line: string) => AD_MARKER_TAGS.some((tag) => line.startsWith(tag));

const filterAndNormalizeMediaPlaylist = (playlistText: string, baseUrl: string) => {
  const lines = playlistText.split(/\r?\n/);
  const normalizedLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    if (shouldFilterTag(line)) {
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:") || line.startsWith("#EXT-X-KEY:")) {
      normalizedLines.push(rewriteUriAttribute(line, baseUrl));
      continue;
    }

    if (line.startsWith("#")) {
      normalizedLines.push(line);
      continue;
    }

    normalizedLines.push(resolveUrl(baseUrl, line));
  }

  if (!normalizedLines[0]?.startsWith("#EXTM3U")) {
    normalizedLines.unshift("#EXTM3U");
  }

  return normalizedLines.join("\n");
};

const parseVariantPlaylistUrls = (playlistText: string, baseUrl: string) => {
  const lines = playlistText.split(/\r?\n/);
  const variants: Array<{ url: string; bandwidth: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    let nextIndex = i + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex].trim();
      if (!nextLine) {
        nextIndex += 1;
        continue;
      }
      if (nextLine.startsWith("#")) {
        break;
      }

      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
      variants.push({
        url: resolveUrl(baseUrl, nextLine),
        bandwidth: bandwidthMatch ? Number(bandwidthMatch[1]) : 0,
      });
      break;
    }
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
};

const fetchM3u8WithTimeout = async (url: string, timeoutMs = 12000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Fetch m3u8 failed with status ${response.status}`);
    }

    const text = await response.text();
    return {
      text,
      finalUrl: response.url || url,
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const resolveToMediaPlaylist = async (playlistUrl: string) => {
  const primary = await fetchM3u8WithTimeout(playlistUrl);

  if (!primary.text.includes("#EXT-X-STREAM-INF")) {
    return primary;
  }

  const variants = parseVariantPlaylistUrls(primary.text, primary.finalUrl);
  if (!variants.length) {
    return primary;
  }

  for (const variant of variants) {
    try {
      const variantPlaylist = await fetchM3u8WithTimeout(variant.url);
      if (variantPlaylist.text.includes("#EXTINF")) {
        return variantPlaylist;
      }
    } catch (error) {
      logger.warn(`[ADBLOCK] Failed to fetch variant playlist: ${variant.url}`);
    }
  }

  return primary;
};

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }
  return (hash >>> 0).toString(16);
};

export const createDiscontinuityFilteredM3u8Url = async (originalUrl: string): Promise<string | null> => {
  if (!isHttpLiveUrl(originalUrl) || !isM3u8LiveUrl(originalUrl)) {
    return null;
  }

  const cachedUrl = filteredPlaylistCache.get(originalUrl);
  if (cachedUrl) {
    const fileInfo = await FileSystem.getInfoAsync(cachedUrl);
    if (fileInfo.exists) {
      return cachedUrl;
    }
    filteredPlaylistCache.delete(originalUrl);
  }

  try {
    const playlist = await resolveToMediaPlaylist(originalUrl);
    if (!playlist.text.includes("#EXTM3U")) {
      return null;
    }

    const filteredPlaylist = filterAndNormalizeMediaPlaylist(playlist.text, playlist.finalUrl);
    if (!filteredPlaylist.includes("#EXTINF")) {
      return null;
    }

    await FileSystem.makeDirectoryAsync(FILTER_CACHE_DIR, { intermediates: true });
    const fileName = `${hashString(originalUrl)}.m3u8`;
    const fileUri = `${FILTER_CACHE_DIR}${fileName}`;

    await FileSystem.writeAsStringAsync(fileUri, filteredPlaylist, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    filteredPlaylistCache.set(originalUrl, fileUri);
    return fileUri;
  } catch (error) {
    logger.warn(`[ADBLOCK] Failed to build filtered playlist for ${originalUrl}`);
    return null;
  }
};

export const getAdFilteredM3u8Candidates = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string,
  proxyToken?: string
): string[] => {
  if (!originalUrl || !apiBaseUrl || !sourceKey) {
    return [];
  }

  if (!isHttpLiveUrl(originalUrl) || !isM3u8LiveUrl(originalUrl)) {
    return [];
  }

  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const encodedSourceKey = encodeURIComponent(sourceKey);
  const sourceParam = `&source=${encodedSourceKey}&moontv-source=${encodedSourceKey}`;
  const tokenParam = proxyToken ? `&token=${encodeURIComponent(proxyToken)}` : "";

  const modernProxyUrl = `${normalizedApiBaseUrl}/api/proxy-m3u8?url=${encodeURIComponent(originalUrl)}${sourceParam}${tokenParam}`;
  const legacyProxyUrl = `${normalizedApiBaseUrl}/api/proxy/m3u8?url=${encodeURIComponent(originalUrl)}&moontv-source=${encodedSourceKey}`;

  return Array.from(new Set([modernProxyUrl, legacyProxyUrl]));
};

export const getAdFilteredLiveUrl = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string,
  proxyToken?: string
): string | null => {
  return getAdFilteredM3u8Candidates(originalUrl, apiBaseUrl, sourceKey, proxyToken)[0] || null;
};

export const getLegacyAdFilteredLiveUrl = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string
): string | null => {
  return getAdFilteredM3u8Candidates(originalUrl, apiBaseUrl, sourceKey)[1] || null;
};

export const getPlaybackUrlCandidates = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string,
  adBlockEnabled: boolean,
  proxyToken?: string
): string[] => {
  const fallbackCandidates = originalUrl ? [originalUrl] : [];
  const adFilteredCandidates = getAdFilteredM3u8Candidates(originalUrl, apiBaseUrl, sourceKey, proxyToken);
  const prioritizedAdFilteredCandidates =
    adFilteredCandidates.length > 1
      ? [adFilteredCandidates[1], adFilteredCandidates[0]]
      : adFilteredCandidates;

  const orderedCandidates = adBlockEnabled
    ? [...prioritizedAdFilteredCandidates, ...fallbackCandidates]
    : [...fallbackCandidates, ...prioritizedAdFilteredCandidates];

  return Array.from(new Set(orderedCandidates.filter((url): url is string => Boolean(url))));
};
