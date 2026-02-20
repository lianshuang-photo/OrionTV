import Logger from "@/utils/Logger";

const logger = Logger.withTag("M3U");

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
}

export const parseM3U = (m3uText: string): Channel[] => {
  const parsedChannels: Channel[] = [];
  const lines = m3uText.split("\n");
  let currentChannelInfo: Partial<Channel> | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("#EXTINF:")) {
      currentChannelInfo = {}; // Start a new channel
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
      currentChannelInfo.id = currentChannelInfo.url; // Use URL as ID

      // Ensure all required fields are present, providing defaults if necessary
      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || "Unknown",
        logo: currentChannelInfo.logo || "",
        group: currentChannelInfo.group || "Default",
      };

      parsedChannels.push(finalChannel);
      currentChannelInfo = null; // Reset for the next channel
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
    return []; // Return empty array on error
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  // In React Native, we use the proxy for all http streams to avoid potential issues.
  // if (originalUrl.toLowerCase().startsWith('http://')) {
  //   // Use the baseURL from the existing api instance.
  //   if (!api.baseURL) {
  //       console.warn("API base URL is not set. Cannot create proxy URL.")
  //       return originalUrl; // Fallback to original URL
  //   }
  //   return `${api.baseURL}/proxy?url=${encodeURIComponent(originalUrl)}`;
  // }
  // HTTPS streams can be played directly.
  return originalUrl;
};

const isHttpUrl = (url: string | null): boolean => {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
};

const isM3u8Url = (url: string | null): boolean => {
  if (!url) return false;
  return /\.m3u8($|\?)/i.test(url);
};

/**
 * Resolve nested M3U8 URLs by fetching and processing them client-side
 * This avoids the backend's 0.0.0.0 issue
 */
export const resolveM3u8Url = async (
  url: string,
  apiBaseUrl: string,
  sourceKey: string,
  proxyToken?: string
): Promise<string> => {
  try {
    // Fetch the master M3U8
    const response = await fetch(url);
    if (!response.ok) {
      logger.info(`Failed to fetch M3U8: ${response.statusText}`);
      return url;
    }

    const content = await response.text();
    const lines = content.split("\n");

    // Check if this is a master playlist (contains EXT-X-STREAM-INF)
    const hasMasterPlaylist = lines.some((line) => line.includes("#EXT-X-STREAM-INF"));

    if (hasMasterPlaylist) {
      // Find the nested M3U8 URL (usually the line after EXT-X-STREAM-INF)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("#EXT-X-STREAM-INF") && i + 1 < lines.length) {
          let nestedUrl = lines[i + 1].trim();

          // Convert relative URL to absolute
          if (!nestedUrl.startsWith("http://") && !nestedUrl.startsWith("https://")) {
            const baseUrl = new URL(url);
            if (nestedUrl.startsWith("/")) {
              nestedUrl = `${baseUrl.protocol}//${baseUrl.host}${nestedUrl}`;
            } else {
              const baseDir = baseUrl.href.substring(0, baseUrl.href.lastIndexOf("/") + 1);
              nestedUrl = new URL(nestedUrl, baseDir).href;
            }
          }

          // Return the nested M3U8 URL with proxy
          const tokenParam = proxyToken ? `&token=${encodeURIComponent(proxyToken)}` : "";
          return `${apiBaseUrl}/api/proxy-m3u8?url=${encodeURIComponent(nestedUrl)}&source=${encodeURIComponent(
            sourceKey
          )}${tokenParam}`;
        }
      }
    }

    // If not a master playlist, proxy it directly
    const tokenParam = proxyToken ? `&token=${encodeURIComponent(proxyToken)}` : "";
    return `${apiBaseUrl}/api/proxy-m3u8?url=${encodeURIComponent(url)}&source=${encodeURIComponent(
      sourceKey
    )}${tokenParam}`;
  } catch (error) {
    logger.info("Error resolving M3U8 URL:", error);
    return url;
  }
};

export const getAdFilteredVodUrl = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string,
  proxyToken?: string,
  vodProxyEnabled: boolean = true
): string | null => {
  if (!originalUrl || !apiBaseUrl || !sourceKey || !vodProxyEnabled) {
    return originalUrl;
  }

  if (!isHttpUrl(originalUrl) || !isM3u8Url(originalUrl)) {
    return originalUrl;
  }

  const tokenParam = proxyToken ? `&token=${encodeURIComponent(proxyToken)}` : "";
  return `${apiBaseUrl}/api/proxy-m3u8?url=${encodeURIComponent(originalUrl)}&source=${encodeURIComponent(
    sourceKey
  )}${tokenParam}`;
};
