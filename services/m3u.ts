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

export const getAdFilteredLiveUrl = (
  originalUrl: string | null,
  apiBaseUrl: string,
  sourceKey: string,
  proxyToken?: string,
): string | null => {
  if (!originalUrl || !apiBaseUrl || !sourceKey) {
    return null;
  }

  if (!isHttpLiveUrl(originalUrl) || !isM3u8LiveUrl(originalUrl)) {
    return null;
  }

  const tokenParam = proxyToken ? `&token=${encodeURIComponent(proxyToken)}` : "";
  return `${apiBaseUrl}/api/proxy-m3u8?url=${encodeURIComponent(originalUrl)}&source=${encodeURIComponent(sourceKey)}${tokenParam}`;
};
