/**
 * Messenger Counter Web Worker
 * Processes Facebook activity JSON logs in a background thread.
 * Xử lý 100% ở Client-side, bảo mật dữ liệu.
 */

// Global storage for files to avoid re-transferring between main thread and worker
let storedFiles = [];

// Curated list of common Vietnamese and English stop words to filter out from word cloud/frequency analysis
const STOP_WORDS = new Set([
  // Vietnamese stop words
  'và', 'là', 'thì', 'mà', 'cũng', 'được', 'có', 'không', 'em', 'anh', 'tui', 'nha', 'đó', 
  'ko', 'nè', 'uh', 'um', 'ơi', 'à', 'nhưng', 'cho', 'với', 'ra', 'vào', 'lại', 'thế', 'này', 
  'đây', 'đó', 'kia', 'đi', 'về', 'lên', 'xuống', 'rồi', 'chưa', 'hết', 'nhé', 'nha', 'thôi', 
  'cả', 'như', 'quá', 'rất', 'hơn', 'bằng', 'từ', 'đến', 'theo', 'trong', 'ngoài', 'trước', 
  'sau', 'ở', 'tại', 'để', 'vì', 'nên', 'do', 'bởi', 'nhờ', 'gì', 'nào', 'sao', 'nó', 'họ', 
  'mình', 'ta', 'tớ', 'cậu', 'bạn', 'ông', 'bà', 'cha', 'mẹ', 'con', 'cháu', 'vâng', 'dạ', 
  'ừ', 'được', 'làm', 'chỉ', 'thấy', 'biết', 'muốn', 'nghĩ', 'nói', 'nghe', 'xem', 'nhìn',
  // English stop words
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', "you're", "you've", 
  "you'll", "you'd", 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 
  'she', "she's", 'her', 'hers', 'herself', 'it', "it's", 'its', 'itself', 'they', 'them', 
  'their', 'theirs', 'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', "that'll", 
  'these', 'those', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 
  'had', 'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 
  'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 
  'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once'
]);

/**
 * Fixes Facebook's broken string encoding (mojibake).
 */
function decodeFBString(str) {
  if (!str || typeof str !== 'string') return str || '';
  
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 255) return str;
    bytes[i] = code;
  }
  
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return str;
  }
}

// ─── Constants (mirrors src/constants.js — keep in sync) ───────────────────
// Classic Web Worker cannot import modules, so we duplicate constants here.
// When updating values, update src/constants.js as well.
const CHAT_TYPES = {
  INDIVIDUAL: 'individual',
  GROUP: 'group',
  DATING: 'dating',
  PAGE: 'page',
};

const REACTION_PATTERNS = [
  /đã bày tỏ cảm xúc.*về tin nhắn/i,
  /reacted to.*message/i,
  /b\u00c3\u00a0y t\u00e1\u00bb\u008f c\u00e1\u00ba\u00a3m x\u00c3\u00bac/i,
];

const PERSONAL_REACTION_PREFIXES = [
  /^(Bạn|You)\s/i,
  /^(B\u00e1\u00ba\u00a1n|B\u00e1\xba\xa1n)\s/i,
];

const UNKNOWN_SENDER = 'Người dùng Facebook';
const DATING_SELF_LABEL = 'Bạn';

const MEDIA_TYPES = {
  PHOTO: 'photo',
  VIDEO: 'video',
  GIF: 'gif',
  AUDIO: 'audio',
  FILE: 'file',
  STICKER: 'sticker',
};
// ───────────────────────────────────────────────────────────────────────────

// isCurrentUser: checks against the detected owner name (set after analysis)
let detectedOwnerName = null;
function isCurrentUser(senderName) {
  if (!senderName) return false;
  if (detectedOwnerName) {
    return senderName === detectedOwnerName;
  }
  // Fallback: generic markers only (no hardcoded personal names)
  const normalized = senderName.toLowerCase();
  return PERSONAL_REACTION_PREFIXES.some(p => p.test(normalized)) || normalized === 'bạn' || normalized === 'you';
}

// Listen for messages from the Main Thread
self.onmessage = async function (e) {
  const { type, data } = e.data;

  if (type === 'SCAN_FILES') {
    await scanFiles(data.files);
  } else if (type === 'ANALYZE_GROUPS') {
    await analyzeGroups(data.selectedGroupIds, data.mergeConfig);
  } else if (type === 'EXPORT_CHAT_JSON') {
    await exportChatJson(data.fileIndices, data.title, data.format, data.messagesList, data.participants);
  }
};

/**
 * Phase 1: Fast Scan
 */
async function scanFiles(files) {
  storedFiles = files; // Store references in worker scope
  const total = files.length;
  const scanResults = [];

  for (let i = 0; i < total; i++) {
    const file = files[i];
    
    if (i % 5 === 0 || i === total - 1) {
      self.postMessage({
        type: 'SCAN_PROGRESS',
        data: {
          current: i + 1,
          total: total,
          fileName: file.name
        }
      });
    }

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const isDating = !!json.recipient && Array.isArray(json.messages);
      const isStandard = !isDating && Array.isArray(json.messages);

      if (isStandard) {
        let rawTitle = json.title || json.threadName || (json.thread_path ? json.thread_path.split(/[\/\\]/).pop() : '') || 'Tin nhắn Messenger';
        let title = decodeFBString(rawTitle).replace(/_\d+$/, '').trim();
        let participants = (json.participants || []).map(p => {
          if (p && typeof p === 'object') {
            return decodeFBString(p.name || p.sender_name || '');
          }
          return decodeFBString(p || '');
        }).filter(Boolean);
        if (participants.length === 0 && title && title !== 'Tin nhắn Messenger') {
          participants.push(title);
        }
        
        let reactionCount = 0;
        let standardMsgCount = 0;
        let firstMsg = '';
        let lastMsg = '';
        const sampleMsgs = [];
        const rawMsgs = json.messages || [];

        for (let j = rawMsgs.length - 1; j >= 0; j--) {
          const msg = rawMsgs[j];
          const c = msg.content || msg.text || msg.body || '';
          if (c) {
            const decoded = decodeFBString(c);
            if (REACTION_PATTERNS.some(p => p.test(decoded) || p.test(c))) {
              reactionCount++;
              continue;
            }
            const rawSender = msg.sender_name || msg.senderName || msg.sender || '';
            const sender = rawSender ? decodeFBString(rawSender) : '';
            const formatted = sender ? `${sender}: ${decoded}` : decoded;
            if (!firstMsg) firstMsg = formatted;
            lastMsg = formatted;
            if (sampleMsgs.length < 10) {
              sampleMsgs.push(formatted);
            }
          }
          standardMsgCount++;
        }

        scanResults.push({
          fileIndex: i,
          fileName: file.name,
          filePath: file.webkitRelativePath || file.name,
          fileSize: file.size,
          title: title,
          participants: participants,
          messageCount: standardMsgCount,
          reactionCount: reactionCount,
          type: 'standard',
          firstMsg: firstMsg,
          lastMsg: lastMsg,
          sampleMsgs: sampleMsgs
        });
      } else if (isDating) {
        const recipient = decodeFBString(json.recipient);
        
        let reactionCount = 0;
        let standardMsgCount = 0;
        let firstMsg = '';
        let lastMsg = '';
        const sampleMsgs = [];
        const rawMsgs = json.messages || [];

        for (let j = rawMsgs.length - 1; j >= 0; j--) {
          const msg = rawMsgs[j];
          const c = msg.content || msg.text || msg.body || '';
          if (c) {
            const decoded = decodeFBString(c);
            if (REACTION_PATTERNS.some(p => p.test(decoded) || p.test(c))) {
              reactionCount++;
              continue;
            }
            const rawSender = msg.sender_name || msg.senderName || msg.sender || '';
            const sender = rawSender ? decodeFBString(rawSender) : recipient;
            const formatted = `${sender}: ${decoded}`;
            if (!firstMsg) firstMsg = formatted;
            lastMsg = formatted;
            if (sampleMsgs.length < 10) {
              sampleMsgs.push(formatted);
            }
          }
          standardMsgCount++;
        }

        scanResults.push({
          fileIndex: i,
          fileName: file.name,
          filePath: file.webkitRelativePath || file.name,
          fileSize: file.size,
          title: recipient,
          participants: [recipient],
          messageCount: standardMsgCount,
          reactionCount: reactionCount,
          type: 'dating',
          firstMsg: firstMsg,
          lastMsg: lastMsg,
          sampleMsgs: sampleMsgs
        });
      }
    } catch (err) {
      console.error(`Error parsing file ${file.name}:`, err);
    }
  }

  const groupsMap = new Map();

  for (const item of scanResults) {
    let signature = '';
    
    if (item.type === 'dating') {
      signature = `dating_${item.title}`;
    } else {
      const sortedParticipants = [...item.participants].sort();
      
      if (sortedParticipants.length === 2) {
        signature = `dm_${sortedParticipants.join('_vs_')}`;
      } else if (sortedParticipants.length > 2) {
        signature = `group_${item.title}_[${sortedParticipants.join('_')}]`;
      } else {
        signature = `chat_${item.title}`;
      }
    }

    if (!groupsMap.has(signature)) {
      groupsMap.set(signature, {
        id: signature,
        title: item.title,
        type: item.type === 'dating' ? CHAT_TYPES.DATING : (item.participants.length > 2 ? CHAT_TYPES.GROUP : (item.participants.length <= 1 ? CHAT_TYPES.PAGE : CHAT_TYPES.INDIVIDUAL)),
        participants: item.participants,
        files: [],
        totalMessages: 0,
        totalReactions: 0,
        totalSize: 0,
        firstMsg: item.firstMsg || '',
        lastMsg: item.lastMsg || '',
        sampleMsgs: item.sampleMsgs || []
      });
    } else {
      const g = groupsMap.get(signature);
      if (!g.firstMsg && item.firstMsg) g.firstMsg = item.firstMsg;
      if (item.lastMsg) g.lastMsg = item.lastMsg;
      if (g.sampleMsgs.length < 10 && Array.isArray(item.sampleMsgs)) {
        for (const mStr of item.sampleMsgs) {
          if (!g.sampleMsgs.includes(mStr) && g.sampleMsgs.length < 10) {
            g.sampleMsgs.push(mStr);
          }
        }
      }
    }

    const group = groupsMap.get(signature);
    group.files.push({
      fileIndex: item.fileIndex,
      fileName: item.fileName,
      filePath: item.filePath,
      fileSize: item.fileSize,
      messageCount: item.messageCount,
      reactionCount: item.reactionCount
    });
    group.totalMessages += item.messageCount;
    group.totalReactions += item.reactionCount;
    group.totalSize += item.fileSize;
  }

  const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => b.totalMessages - a.totalMessages);
  scannedGroupsCache = sortedGroups;

  self.postMessage({
    type: 'SCAN_COMPLETE',
    data: {
      groups: sortedGroups
    }
  });
}

/**
 * Phase 2: Deep Analysis
 */
async function analyzeGroups(selectedGroupIds, mergeConfig) {
  const enabledGroupIdsSet = new Set(selectedGroupIds);
  const totalFilesToProcess = storedFiles.length;
  
  const groupMappings = new Map();
  for (const groupId of selectedGroupIds) {
    let targetId = groupId;
    if (mergeConfig && mergeConfig[groupId]) {
      targetId = mergeConfig[groupId];
    }
    groupMappings.set(groupId, targetId);
  }

  const analyticsResults = new Map();

  self.postMessage({
    type: 'ANALYZE_START',
    data: { total: selectedGroupIds.length }
  });

  let fileProgressCount = 0;
  let processedMessageCount = 0;

  const initStatsGroup = (id, title, type, participants) => ({
    id,
    title,
    type,
    participants,
    files: [],
    
    // General Stats (Both participants)
    messageCount: 0,
    reactionCount: 0,
    mediaCounts: { photos: 0, videos: 0, gifs: 0, audio: 0, files: 0, stickers: 0 },
    senderCounts: {},
    hourlyCounts: new Array(24).fill(0),
    yearlyCounts: {},
    monthlyCounts: {},
    dayOfWeekCounts: new Array(7).fill(0),
    totalCharacters: 0,
    totalWords: 0,
    wordFrequencies: {},

    // Personal Stats (Only current user)
    personal: {
      messageCount: 0,
      reactionCount: 0,
      mediaCounts: { photos: 0, videos: 0, gifs: 0, audio: 0, files: 0, stickers: 0 },
      hourlyCounts: new Array(24).fill(0),
      yearlyCounts: {},
      monthlyCounts: {},
      dayOfWeekCounts: new Array(7).fill(0),
      totalCharacters: 0,
      totalWords: 0,
      wordFrequencies: {}
    },

    dateRange: { start: null, end: null },
    messagesList: [] // Combined list of all messages in this group
  });

  const globalStats = {
    // General
    myName: null, // Detected owner name (most frequent sender in DMs)
    totalMessages: 0,
    totalReactions: 0,
    totalMedia: 0,
    totalWords: 0,
    totalCharacters: 0,
    hourlyCounts: new Array(24).fill(0),
    monthlyCounts: {},
    dayOfWeekCounts: new Array(7).fill(0),
    mediaCounts: { photos: 0, videos: 0, gifs: 0, audio: 0, files: 0, stickers: 0 },
    
    // Personal
    personal: {
      totalMessages: 0,
      totalReactions: 0,
      totalMedia: 0,
      totalWords: 0,
      totalCharacters: 0,
      hourlyCounts: new Array(24).fill(0),
      monthlyCounts: {},
      dayOfWeekCounts: new Array(7).fill(0),
      mediaCounts: { photos: 0, videos: 0, gifs: 0, audio: 0, files: 0, stickers: 0 }
    },

    dateRange: { start: null, end: null }
  };

  // Track sender frequency across all DM conversations to auto-detect the owner
  const ownerSenderFreq = {};


  for (let fileIndex = 0; fileIndex < storedFiles.length; fileIndex++) {
    const file = storedFiles[fileIndex];

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const isDating = !!json.recipient && Array.isArray(json.messages);
      const isStandard = !isDating && Array.isArray(json.messages);
      
      let signature = '';
      let title = '';
      let type = '';
      let participants = [];

      if (isStandard) {
        let rawTitle = json.title || json.threadName || (json.thread_path ? json.thread_path.split(/[\/\\]/).pop() : '') || 'Tin nhắn Messenger';
        title = decodeFBString(rawTitle).replace(/_\d+$/, '').trim();
        participants = (json.participants || []).map(p => {
          if (p && typeof p === 'object') {
            return decodeFBString(p.name || p.sender_name || '');
          }
          return decodeFBString(p || '');
        }).filter(Boolean);
        if (participants.length === 0 && title && title !== 'Tin nhắn Messenger') {
          participants.push(title);
        }
        const sortedParticipants = [...participants].sort();
        if (sortedParticipants.length === 2) {
          signature = `dm_${sortedParticipants.join('_vs_')}`;
        } else if (sortedParticipants.length > 2) {
          signature = `group_${title}_[${sortedParticipants.join('_')}]`;
        } else {
          signature = `chat_${title}`;
        }
        type = participants.length > 2 ? CHAT_TYPES.GROUP : (participants.length <= 1 ? CHAT_TYPES.PAGE : CHAT_TYPES.INDIVIDUAL);
      } else if (isDating) {
        title = decodeFBString(json.recipient);
        participants = [title];
        signature = `dating_${title}`;
        type = CHAT_TYPES.DATING;
      } else {
        continue;
      }

      const targetGroupId = groupMappings.get(signature) || signature;

      const isEnabled = enabledGroupIdsSet.has(signature) || enabledGroupIdsSet.has(targetGroupId);
      if (!isEnabled) {
        continue;
      }

      if (!analyticsResults.has(targetGroupId)) {
        let metaTitle = title;
        let metaType = type;
        let metaParticipants = participants;

        const targetMeta = scannedGroupsCache.find(g => g.id === targetGroupId);
        if (targetMeta) {
          metaTitle = targetMeta.title;
          metaType = targetMeta.type;
          metaParticipants = targetMeta.participants;
        }

        analyticsResults.set(targetGroupId, initStatsGroup(targetGroupId, metaTitle, metaType, metaParticipants));
      }

      const stats = analyticsResults.get(targetGroupId);
      const messages = json.messages || [];
      
      stats.files.push({
        fileIndex: fileIndex,
        fileName: file.name,
        filePath: file.webkitRelativePath || file.name,
        fileSize: file.size,
        messageCount: messages.length
      });
      
      fileProgressCount++;
      self.postMessage({
        type: 'ANALYZE_PROGRESS',
        data: {
          currentFile: fileProgressCount,
          fileName: file.name,
          processedMessages: processedMessageCount
        }
      });

      for (const msg of messages) {
        processedMessageCount++;
        
        // 1. Sender
        let sender = UNKNOWN_SENDER;
        const rawSender = msg.sender_name || msg.senderName || msg.sender;
        if (rawSender) {
          sender = decodeFBString(rawSender);
        } else if (isDating) {
          let datingUserSender = detectedOwnerName;
          const targetMeta = scannedGroupsCache.find(g => g.id === targetGroupId);
          if (!datingUserSender && targetMeta && Array.isArray(targetMeta.participants)) {
            const otherP = targetMeta.participants.find(p => p !== title && p !== (stats ? stats.title : ''));
            if (otherP) datingUserSender = otherP;
          }
          sender = datingUserSender || (detectedOwnerName || 'Bạn');
        }

        // 2. Timestamp
        let timestampMs = 0;
        if (msg.timestamp_ms) {
          timestampMs = msg.timestamp_ms;
        } else if (msg.timestamp) {
          if (msg.timestamp > 1000000000000) {
            timestampMs = msg.timestamp;
          } else {
            timestampMs = msg.timestamp * 1000;
          }
        }

        // Check if message is a reaction message
        const contentStr = msg.content || msg.text || msg.body || '';
        let decodedContent = '';
        let isReactionMsg = false;
        if (contentStr) {
          decodedContent = decodeFBString(contentStr);
          isReactionMsg = REACTION_PATTERNS.some(p => p.test(decodedContent) || p.test(contentStr));
        }

        const isMe = isCurrentUser(sender);

        if (isReactionMsg) {
          stats.reactionCount = (stats.reactionCount || 0) + 1;
          globalStats.totalReactions = (globalStats.totalReactions || 0) + 1;

          const isPersonalReaction = isMe || PERSONAL_REACTION_PREFIXES.some(p => p.test(decodedContent) || p.test(contentStr));

          if (isPersonalReaction) {
            stats.personal.reactionCount = (stats.personal.reactionCount || 0) + 1;
            globalStats.personal.totalReactions = (globalStats.personal.totalReactions || 0) + 1;
          }

          stats.messagesList.push({
            sender: sender,
            timestamp: timestampMs,
            content: decodedContent,
            isMedia: false,
            isReaction: true,
            isDating: isDating
          });
          continue;
        }

        stats.senderCounts[sender] = (stats.senderCounts[sender] || 0) + 1;

        // Track each unique sender-group pair to detect owner (appears in most DM groups)
        if (type === CHAT_TYPES.INDIVIDUAL) {
          const dmKey = `${sender}__${targetGroupId}`;
          if (!ownerSenderFreq[sender]) ownerSenderFreq[sender] = new Set();
          ownerSenderFreq[sender].add(targetGroupId);
        }


        let dateObj = null;
        if (timestampMs > 0) {
          dateObj = new Date(timestampMs);
          const hour = dateObj.getHours();
          const year = dateObj.getFullYear();
          const month = dateObj.getMonth();
          const dayOfWeek = dateObj.getDay();
          const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

          // General counts
          stats.hourlyCounts[hour]++;
          stats.yearlyCounts[year] = (stats.yearlyCounts[year] || 0) + 1;
          stats.monthlyCounts[yearMonth] = (stats.monthlyCounts[yearMonth] || 0) + 1;
          stats.dayOfWeekCounts[dayOfWeek]++;

          globalStats.hourlyCounts[hour]++;
          globalStats.monthlyCounts[yearMonth] = (globalStats.monthlyCounts[yearMonth] || 0) + 1;
          globalStats.dayOfWeekCounts[dayOfWeek]++;

          // Personal counts
          if (isMe) {
            stats.personal.hourlyCounts[hour]++;
            stats.personal.yearlyCounts[year] = (stats.personal.yearlyCounts[year] || 0) + 1;
            stats.personal.monthlyCounts[yearMonth] = (stats.personal.monthlyCounts[yearMonth] || 0) + 1;
            stats.personal.dayOfWeekCounts[dayOfWeek]++;

            globalStats.personal.hourlyCounts[hour]++;
            globalStats.personal.monthlyCounts[yearMonth] = (globalStats.personal.monthlyCounts[yearMonth] || 0) + 1;
            globalStats.personal.dayOfWeekCounts[dayOfWeek]++;
          }

          if (!stats.dateRange.start || timestampMs < stats.dateRange.start) stats.dateRange.start = timestampMs;
          if (!stats.dateRange.end || timestampMs > stats.dateRange.end) stats.dateRange.end = timestampMs;

          if (!globalStats.dateRange.start || timestampMs < globalStats.dateRange.start) globalStats.dateRange.start = timestampMs;
          if (!globalStats.dateRange.end || timestampMs > globalStats.dateRange.end) globalStats.dateRange.end = timestampMs;
        }

        // 3. Media counts
        let hasMedia = false;
        let mediaTypeLabel = null;
        if (msg.photos && msg.photos.length > 0) {
          const count = msg.photos.length;
          stats.mediaCounts.photos += count;
          globalStats.mediaCounts.photos += count;
          if (isMe) {
            stats.personal.mediaCounts.photos += count;
            globalStats.personal.mediaCounts.photos += count;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.PHOTO;
        }
        if (msg.videos && msg.videos.length > 0) {
          const count = msg.videos.length;
          stats.mediaCounts.videos += count;
          globalStats.mediaCounts.videos += count;
          if (isMe) {
            stats.personal.mediaCounts.videos += count;
            globalStats.personal.mediaCounts.videos += count;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.VIDEO;
        }
        if (msg.gifs && msg.gifs.length > 0) {
          const count = msg.gifs.length;
          stats.mediaCounts.gifs += count;
          globalStats.mediaCounts.gifs += count;
          if (isMe) {
            stats.personal.mediaCounts.gifs += count;
            globalStats.personal.mediaCounts.gifs += count;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.GIF;
        }
        if (msg.audio_files && msg.audio_files.length > 0) {
          const count = msg.audio_files.length;
          stats.mediaCounts.audio += count;
          globalStats.mediaCounts.audio += count;
          if (isMe) {
            stats.personal.mediaCounts.audio += count;
            globalStats.personal.mediaCounts.audio += count;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.AUDIO;
        }
        if (msg.files && msg.files.length > 0) {
          const count = msg.files.length;
          stats.mediaCounts.files += count;
          globalStats.mediaCounts.files += count;
          if (isMe) {
            stats.personal.mediaCounts.files += count;
            globalStats.personal.mediaCounts.files += count;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.FILE;
        }
        if (msg.sticker) {
          stats.mediaCounts.stickers++;
          globalStats.mediaCounts.stickers++;
          if (isMe) {
            stats.personal.mediaCounts.stickers++;
            globalStats.personal.mediaCounts.stickers++;
          }
          hasMedia = true;
          mediaTypeLabel = MEDIA_TYPES.STICKER;
        }

        if (msg.media && msg.media.length > 0) {
          const mediaCount = msg.media.length;
          const isPhoto = msg.type === 'image' || msg.media.some(m => m.uri && m.uri.match(/\.(png|jpg|jpeg|webp)$/i));
          const isVideo = msg.type === 'video' || msg.media.some(m => m.uri && m.uri.match(/\.(mp4|avi|mov|mkv)$/i));
          
          if (isPhoto) {
            stats.mediaCounts.photos += mediaCount;
            globalStats.mediaCounts.photos += mediaCount;
            if (isMe) {
              stats.personal.mediaCounts.photos += mediaCount;
              globalStats.personal.mediaCounts.photos += mediaCount;
            }
            mediaTypeLabel = MEDIA_TYPES.PHOTO;
          } else if (isVideo) {
            stats.mediaCounts.videos += mediaCount;
            globalStats.mediaCounts.videos += mediaCount;
            if (isMe) {
              stats.personal.mediaCounts.videos += mediaCount;
              globalStats.personal.mediaCounts.videos += mediaCount;
            }
            mediaTypeLabel = MEDIA_TYPES.VIDEO;
          } else {
            stats.mediaCounts.files += mediaCount;
            globalStats.mediaCounts.files += mediaCount;
            if (isMe) {
              stats.personal.mediaCounts.files += mediaCount;
              globalStats.personal.mediaCounts.files += mediaCount;
            }
            mediaTypeLabel = MEDIA_TYPES.FILE;
          }
          hasMedia = true;
        }

        if (hasMedia) {
          globalStats.totalMedia++;
          if (isMe) {
            globalStats.personal.totalMedia++;
          }
        }

        // 3.5. Reactions array check (supports Facebook E2EE and structured reaction objects)
        if (Array.isArray(msg.reactions) && msg.reactions.length > 0) {
          const reactCount = msg.reactions.length;
          stats.reactionCount = (stats.reactionCount || 0) + reactCount;
          globalStats.totalReactions = (globalStats.totalReactions || 0) + reactCount;

          for (const r of msg.reactions) {
            const actor = decodeFBString(r.actor || r.sender || r.sender_name || '');
            const isPersonal = (actor && isCurrentUser(actor)) || isMe;
            if (isPersonal) {
              stats.personal.reactionCount = (stats.personal.reactionCount || 0) + 1;
              globalStats.personal.totalReactions = (globalStats.personal.totalReactions || 0) + 1;
            }
          }
        }

        // 4. Text Content
        if (contentStr) {
          const charLength = decodedContent.length;
          stats.totalCharacters += charLength;
          globalStats.totalCharacters += charLength;

          const words = decodedContent
            .toLowerCase()
            .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'’+]/g, ' ')
            .split(/\s+/);

          let validWordCount = 0;
          for (const word of words) {
            if (word && word.length > 1) {
              validWordCount++;
              if (!STOP_WORDS.has(word) && isNaN(word)) {
                stats.wordFrequencies[word] = (stats.wordFrequencies[word] || 0) + 1;
              }
            }
          }

          stats.totalWords += validWordCount;
          globalStats.totalWords += validWordCount;

          if (isMe) {
            stats.personal.totalCharacters += charLength;
            globalStats.personal.totalCharacters += charLength;

            let validWordCountPersonal = 0;
            for (const word of words) {
              if (word && word.length > 1) {
                validWordCountPersonal++;
                if (!STOP_WORDS.has(word) && isNaN(word)) {
                  stats.personal.wordFrequencies[word] = (stats.personal.wordFrequencies[word] || 0) + 1;
                }
              }
            }

            stats.personal.totalWords += validWordCountPersonal;
            globalStats.personal.totalWords += validWordCountPersonal;
          }
        }

        // Collect message details for Chat Viewer
        stats.messagesList.push({
          sender: sender,
          timestamp: timestampMs,
          content: decodedContent,
          isMedia: hasMedia,
          mediaType: mediaTypeLabel,
          isDating: isDating
        });

        stats.messageCount++;
        globalStats.totalMessages++;
        
        if (isMe) {
          stats.personal.messageCount++;
          globalStats.personal.totalMessages++;
        }
      }

    } catch (err) {
      console.error(`Error processing file index ${fileIndex}:`, err);
    }
  }

  // Detect owner name: the sender who appears in the most unique DM conversations
  // (the account owner is always a participant in every conversation they have)
  if (Object.keys(ownerSenderFreq).length > 0) {
    const detectedName = Object.entries(ownerSenderFreq)
      .sort((a, b) => b[1].size - a[1].size)[0][0];
    globalStats.myName = detectedName;
    detectedOwnerName = detectedName; // Set global for isCurrentUser
  }


  // Post-processing of word frequencies and message sorting
  const finalGroups = Array.from(analyticsResults.values()).map(group => {
    // Keep top 100 words (General)
    const sortedWords = Object.entries(group.wordFrequencies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);

    // Keep top 100 words (Personal)
    const sortedWordsPersonal = Object.entries(group.personal.wordFrequencies)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);

    // Sort messages chronologically (oldest to newest)
    group.messagesList.sort((a, b) => a.timestamp - b.timestamp);

    return {
      ...group,
      wordFrequencies: Object.fromEntries(sortedWords),
      personal: {
        ...group.personal,
        wordFrequencies: Object.fromEntries(sortedWordsPersonal)
      },
      participants: group.type === CHAT_TYPES.DATING ? [DATING_SELF_LABEL, group.title] : group.participants
    };
  });

  self.postMessage({
    type: 'ANALYZE_COMPLETE',
    data: {
      globalStats,
      groups: finalGroups.sort((a, b) => b.messageCount - a.messageCount)
    }
  });
}

function formatTimestampToReadable(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (isNaN(date.getTime())) return '';
  const YYYY = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, '0');
  const DD = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}

/**
 * Phase 3: Export single chat JSON / Plain Text with decoded characters and custom formats
 */
async function exportChatJson(fileIndices, title, format, fallbackMessagesList, fallbackParticipants) {
  const messages = [];
  const participantsSet = new Set();

  let hasDating = false;

  if (storedFiles.length > 0 && Array.isArray(fileIndices)) {
    for (const fileIndex of fileIndices) {
      const file = storedFiles[fileIndex];
      if (!file) continue;

      try {
        const text = await file.text();
        const json = JSON.parse(text);

        if (json.recipient && Array.isArray(json.messages)) {
          hasDating = true;
        }

        if (Array.isArray(json.participants)) {
          for (const p of json.participants) {
            const name = typeof p === 'object' ? (p.name || p.sender_name || '') : p;
            if (name) participantsSet.add(decodeFBString(name));
          }
        } else if (json.recipient) {
          participantsSet.add(decodeFBString(json.recipient));
        }

        const rawMessages = json.messages || [];
        for (const msg of rawMessages) {
          messages.push(msg);
        }
      } catch (err) {
        console.error('Error parsing file for export:', err);
      }
    }
  }

  if (storedFiles.length === 0 && format !== 'mine' && format !== 'clean_json' && format !== 'plain_text') {
    self.postMessage({
      type: 'EXPORT_CHAT_JSON_ERROR',
      data: {
        title: title,
        format: format
      }
    });
    return;
  }

  // Format 1: PLAIN TEXT (.txt dialogue log)
  if (format === 'plain_text') {
    const rawList = messages.length > 0 ? messages : (fallbackMessagesList || []);
    const sorted = [...rawList].sort((a, b) => {
      let tA = a.timestamp_ms || a.timestamp || 0;
      let tB = b.timestamp_ms || b.timestamp || 0;
      if (tA > 0 && tA < 1000000000000) tA *= 1000;
      if (tB > 0 && tB < 1000000000000) tB *= 1000;
      return tA - tB;
    });

    const participantsList = participantsSet.size > 0 ? Array.from(participantsSet) : (fallbackParticipants || []);
    const lines = [
      `Conversation: ${title}`,
      `Participants: ${participantsList.join(', ')}`,
      `----------------------------------------`
    ];

    if (hasDating || title.includes('Hẹn hò') || title.includes('Dating')) {
      lines.push(`[LƯU Ý / NOTE FOR AI]: Đoạn chat này chứa dữ liệu từ tệp Facebook Dating (dating/messages/*.json). Tệp Facebook Dating gốc CHỈ LƯU DUY NHẤT tin nhắn do bạn gửi đi, HOÀN TOÀN KHÔNG LƯU tin nhắn phản hồi của đối phương.`);
      lines.push(`[MẸO ĐỒNG BỘ / DATING SYNC TIP]: Cần chọn bấm nút 'Gửi thông tin / Chuyển sang Messenger' trực tiếp từ Facebook Dating thay vì gửi link Profile rồi tự kết bạn nhắn riêng, để Facebook tự động đồng bộ đầy đủ lịch sử chat 2 chiều sang Messenger kèm nhãn 'Đã gửi từ Hẹn hò trên Facebook'.`);
      lines.push(`----------------------------------------`);
    }

    let inDatingBlock = false;

    for (const msg of sorted) {
      const isDatingMsg = !!msg.isDating || (!msg.sender_name && !msg.sender && (hasDating || title.includes('Hẹn hò') || title.includes('Dating')));

      if (isDatingMsg && !inDatingBlock) {
        inDatingBlock = true;
        lines.push(`----------------------------------------`);
        lines.push(`[BẮT ĐẦU CHAT HẸN HÒ / START DATING CHAT - NOTE FOR AI]: Bắt đầu đoạn tin nhắn từ Facebook Dating (dating/messages/*.json). Tệp Hẹn hò gốc chỉ lưu tin nhắn 1 chiều do bạn gửi đi.`);
        lines.push(`----------------------------------------`);
      } else if (!isDatingMsg && inDatingBlock) {
        inDatingBlock = false;
        lines.push(`----------------------------------------`);
        lines.push(`[KẾT THÚC CHAT HẸN HÒ / END DATING CHAT - NOTE FOR AI]: Kết thúc đoạn tin nhắn từ Facebook Dating. Các tin nhắn tiếp theo bên dưới là từ Messenger chính thức (hội thoại 2 chiều).`);
        lines.push(`----------------------------------------`);
      }

      const contentStr = msg.content || msg.text || msg.body || '';
      const decodedContent = contentStr ? decodeFBString(contentStr) : '';
      const rawSender = msg.sender || msg.sender_name || msg.senderName;
      let sender = UNKNOWN_SENDER;
      if (rawSender) {
        sender = decodeFBString(rawSender);
      } else if (isDatingMsg || hasDating || title.includes('Hẹn hò') || title.includes('Dating')) {
        sender = detectedOwnerName || 'Bạn';
      }

      let timestampMs = msg.timestamp_ms || msg.timestamp || 0;
      if (timestampMs > 0 && timestampMs < 1000000000000) timestampMs *= 1000;

      const timeStr = formatTimestampToReadable(timestampMs);
      lines.push(`[${timeStr}] ${sender}: ${decodedContent}`);
    }

    if (inDatingBlock) {
      lines.push(`----------------------------------------`);
      lines.push(`[KẾT THÚC CHAT HẸN HÒ / END DATING CHAT - NOTE FOR AI]: Kết thúc đoạn tin nhắn từ Facebook Dating.`);
      lines.push(`----------------------------------------`);
    }

    self.postMessage({
      type: 'EXPORT_CHAT_JSON_COMPLETE',
      data: {
        title: title,
        jsonContent: null,
        textContent: lines.join('\n'),
        format: 'plain_text'
      }
    });
    return;
  }

  let outputObj;

  // Format 2: CLEAN JSON (mine / clean_json)
  if (format === 'mine' || format === 'clean_json') {
    const rawList = messages.length > 0 ? messages : (fallbackMessagesList || []);
    const customMessages = rawList.map((msg) => {
      const contentStr = msg.content || msg.text || msg.body || '';
      let decodedContent = contentStr ? decodeFBString(contentStr) : '';

      const isDatingMsg = !!msg.isDating || (!msg.sender_name && !msg.sender && (hasDating || title.includes('Hẹn hò')));
      let sender = UNKNOWN_SENDER;
      const rawSender = msg.sender || msg.sender_name || msg.senderName;
      if (rawSender) {
        sender = decodeFBString(rawSender);
      } else if (isDatingMsg || hasDating || title.includes('Hẹn hò') || title.includes('Dating')) {
        sender = detectedOwnerName || 'Bạn';
      }

      let timestampMs = msg.timestamp_ms || msg.timestamp || 0;
      if (timestampMs > 0 && timestampMs < 1000000000000) {
        timestampMs *= 1000;
      }

      const item = {
        time: formatTimestampToReadable(timestampMs),
        sender,
        content: decodedContent,
        isDating: isDatingMsg
      };

      if (
        (msg.photos && msg.photos.length > 0) ||
        (msg.videos && msg.videos.length > 0) ||
        (msg.gifs && msg.gifs.length > 0) ||
        (msg.audio_files && msg.audio_files.length > 0) ||
        (msg.files && msg.files.length > 0) ||
        msg.sticker ||
        (msg.media && msg.media.length > 0) ||
        msg.isMedia
      ) {
        let mediaTypeLabel = msg.mediaType || MEDIA_TYPES.FILE;
        if (msg.photos || (msg.media && msg.type === 'image')) mediaTypeLabel = MEDIA_TYPES.PHOTO;
        else if (msg.videos || (msg.media && msg.type === 'video')) mediaTypeLabel = MEDIA_TYPES.VIDEO;
        else if (msg.gifs) mediaTypeLabel = MEDIA_TYPES.GIF;
        else if (msg.audio_files) mediaTypeLabel = MEDIA_TYPES.AUDIO;
        else if (msg.sticker) mediaTypeLabel = MEDIA_TYPES.STICKER;
        item.media = mediaTypeLabel;
      }

      const isReaction = msg.isReaction || REACTION_PATTERNS.some(p => p.test(decodedContent) || p.test(contentStr)) || (Array.isArray(msg.reactions) && msg.reactions.length > 0);
      if (isReaction) {
        item.isReaction = true;
      }

      return item;
    });

    customMessages.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    const finalCustomMessages = [];
    if (hasDating || title.includes('Hẹn hò') || title.includes('Dating')) {
      if (customMessages.length > 0) {
        finalCustomMessages.push({
          time: customMessages[0].time,
          sender: "System Note",
          content: "[LƯU Ý / NOTE FOR AI]: Đoạn chat này chứa dữ liệu từ tệp Facebook Dating (dating/messages/*.json). Tệp Facebook Dating gốc CHỈ LƯU DUY NHẤT tin nhắn do bạn gửi đi, HOÀN TOÀN KHÔNG LƯU tin nhắn phản hồi của đối phương. (Mẹo: Cần bấm nút 'Gửi thông tin / Chuyển sang Messenger' trực tiếp từ Facebook Dating để Facebook tự động đồng bộ đầy đủ lịch sử chat 2 chiều sang Messenger)."
        });
      }
    }

    let inDatingBlockClean = false;
    for (const item of customMessages) {
      if (item.isDating && !inDatingBlockClean) {
        inDatingBlockClean = true;
        finalCustomMessages.push({
          time: item.time,
          sender: "System Note",
          content: "[BẮT ĐẦU CHAT HẸN HÒ / START DATING CHAT - NOTE FOR AI]: Bắt đầu đoạn tin nhắn từ Facebook Dating."
        });
      } else if (!item.isDating && inDatingBlockClean) {
        inDatingBlockClean = false;
        finalCustomMessages.push({
          time: item.time,
          sender: "System Note",
          content: "[KẾT THÚC CHAT HẸN HÒ / END DATING CHAT - NOTE FOR AI]: Kết thúc đoạn tin nhắn từ Facebook Dating. Các tin nhắn tiếp theo bên dưới là từ Messenger chính thức (hội thoại 2 chiều)."
        });
      }
      finalCustomMessages.push(item);
    }

    if (inDatingBlockClean && finalCustomMessages.length > 0) {
      finalCustomMessages.push({
        time: finalCustomMessages[finalCustomMessages.length - 1].time,
        sender: "System Note",
        content: "[KẾT THÚC CHAT HẸN HÒ / END DATING CHAT - NOTE FOR AI]: Kết thúc đoạn tin nhắn từ Facebook Dating."
      });
    }

    const participantsList = participantsSet.size > 0 ? Array.from(participantsSet) : (fallbackParticipants || []);

    outputObj = {
      title: title,
      participants: participantsList,
      ...(hasDating ? { dating_note: "Đoạn chat này chứa dữ liệu từ tệp Facebook Dating (dating/messages/*.json). Tệp Facebook Dating gốc CHỈ LƯU DUY NHẤT tin nhắn do bạn gửi đi, HOÀN TOÀN KHÔNG LƯU tin nhắn phản hồi của đối phương. (Mẹo: Cần bấm nút 'Gửi thông tin / Chuyển sang Messenger' trực tiếp từ Facebook Dating để Facebook tự động đồng bộ đầy đủ lịch sử chat 2 chiều sang Messenger)." } : {}),
      messages: finalCustomMessages
    };

  } else {
    // Formats 3 & 4: Facebook Original formats (fb_old / fb_e2ee)
    const fbMessages = messages.map(msg => {
      const contentStr = msg.content || msg.text || msg.body || '';
      const decodedContent = contentStr ? decodeFBString(contentStr) : '';

      const rawSender = msg.sender_name || msg.senderName || UNKNOWN_SENDER;
      const decodedSender = decodeFBString(rawSender);

      let timestampMs = msg.timestamp_ms || msg.timestamp || 0;
      if (timestampMs > 0 && timestampMs < 1000000000000) {
        timestampMs *= 1000;
      }

      const reactions = (msg.reactions || []).map(r => ({
        reaction: decodeFBString(r.reaction),
        actor: decodeFBString(r.actor || r.sender || '')
      }));

      const mapMediaArray = (arr) => {
        if (!Array.isArray(arr)) return undefined;
        return arr.map(item => ({
          uri: decodeFBString(item.uri || ''),
          creation_timestamp: item.creation_timestamp || (item.timestamp ? (item.timestamp > 1000000000000 ? item.timestamp : item.timestamp * 1000) : undefined)
        }));
      };

      const photos = mapMediaArray(msg.photos);
      const videos = mapMediaArray(msg.videos);
      const audio_files = mapMediaArray(msg.audio_files);
      const gifs = mapMediaArray(msg.gifs);
      const files = mapMediaArray(msg.files);
      const sticker = msg.sticker ? { uri: decodeFBString(msg.sticker.uri || '') } : undefined;

      const mappedMsg = {};

      if (format === 'fb_old') {
        mappedMsg.sender_name = decodedSender;
        mappedMsg.timestamp_ms = timestampMs;
      } else {
        mappedMsg.senderName = decodedSender;
        mappedMsg.timestampMs = timestampMs;
      }

      if (decodedContent) mappedMsg.content = decodedContent;
      if (reactions.length > 0) mappedMsg.reactions = reactions;
      if (photos) mappedMsg.photos = photos;
      if (videos) mappedMsg.videos = videos;
      if (audio_files) mappedMsg.audio_files = audio_files;
      if (gifs) mappedMsg.gifs = gifs;
      if (files) mappedMsg.files = files;
      if (sticker) mappedMsg.sticker = sticker;

      if (msg.ip) mappedMsg.ip = msg.ip;
      if (msg.call_duration) mappedMsg.call_duration = msg.call_duration;
      if (msg.missed !== undefined) mappedMsg.missed = msg.missed;

      return mappedMsg;
    });

    fbMessages.sort((a, b) => {
      const tA = a.timestamp_ms || a.timestampMs || 0;
      const tB = b.timestamp_ms || b.timestampMs || 0;
      return tB - tA;
    });

    outputObj = {
      title: title,
      participants: Array.from(participantsSet).map(name => ({ name })),
      messages: fbMessages,
      is_still_participant: true,
      thread_path: `inbox/${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`
    };
  }

  self.postMessage({
    type: 'EXPORT_CHAT_JSON_COMPLETE',
    data: {
      title: title,
      jsonContent: outputObj,
      format: format
    }
  });
}

