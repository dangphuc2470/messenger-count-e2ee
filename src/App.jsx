import React, { useState, useEffect, useRef } from 'react';
import { CHAT_TYPES, PERSONAL_REACTION_PREFIXES, UNKNOWN_SENDER, MEDIA_TYPES } from './constants';
import {
  BarChart2, MessageSquare, Shield, Users,
  FolderOpen, Calendar, Image, FileText, ChevronRight,
  Search, ArrowUpDown, X, Loader2, Info, ArrowLeft, RefreshCw,
  Clock, Award, MessageCircle, Sparkles, ChevronDown, Download, User,
  LayoutGrid, List, FileArchive
} from 'lucide-react';
import { Chart, registerables } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import html2canvas from 'html2canvas-pro';
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';

// Register Chart.js components
Chart.register(...registerables, zoomPlugin);

// ─── ZIP Streaming Helper ─────────────────────────────────────────────────────
// Streams a ZIP file entry-by-entry using fflate, extracting only matching JSON files.
// Never loads the full ZIP into RAM — processes in 64KB chunks via ReadableStream.
const MESSAGE_FILE_REGEX = /(messages[\/\\](inbox|e2ee_cutover|archived_threads|message_requests|filtered_threads|extracted)?[\/\\]|dating[\/\\]messages[\/\\]).*\.json$/i;

function extractJsonsFromZip(zipFile, onProgress) {
  return new Promise((resolve, reject) => {
    const blobs = [];
    let entryCount = 0;
    let zipType = null; // 'facebook' | 'e2ee_flat'

    const unzipper = new Unzip((stream) => {
      const name = stream.name;
      entryCount++;

      // Detect ZIP type from first entries
      if (zipType === null) {
        if (name.startsWith('your_facebook_activity/') || MESSAGE_FILE_REGEX.test(name)) {
          zipType = 'facebook';
        } else if (!name.includes('/') && name.endsWith('.json')) {
          zipType = 'e2ee_flat';
        }
      }

      const isFacebookJson = zipType === 'facebook' && MESSAGE_FILE_REGEX.test(name);
      // e2ee_flat: root-level .json files (no slash in name)
      const isE2EEFlatJson = (zipType === 'e2ee_flat' || zipType === null) && !name.includes('/') && name.endsWith('.json');

      if (!isFacebookJson && !isE2EEFlatJson) return; // skip — don't decompress

      const chunks = [];
      stream.ondata = (err, data, final) => {
        if (err) return;
        if (data) chunks.push(data);
        if (final) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of chunks) { merged.set(c, offset); offset += c.length; }

          const fileName = name.split('/').pop();
          // E2EE flat files get a virtual path so the worker's E2EE detection works
          const virtualPath = isE2EEFlatJson ? `messages/extracted/${fileName}` : name;
          // Use File (not Blob) — File.name is preserved in postMessage structured clone;
          // Blob custom properties set via Object.defineProperty are NOT.
          // Worker uses `file.webkitRelativePath || file.name` so full path as name works.
          const fileObj = new File([merged], virtualPath, { type: 'application/json' });
          blobs.push(fileObj);
          if (onProgress) onProgress(blobs.length, fileName);
        }
      };
      stream.start();
    });
    unzipper.register(UnzipInflate);    // method 8 - DEFLATE
    unzipper.register(UnzipPassThrough); // method 0 - STORED (uncompressed)

    const reader = zipFile.stream().getReader();
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          try { unzipper.push(new Uint8Array(0), true); } catch (_) {}
          resolve(blobs);
          return;
        }
        try { unzipper.push(value); } catch (err) { reject(err); return; }
        pump();
      }).catch(reject);
    }
    pump();
  });
}
// ─────────────────────────────────────────────────────────────────────────────


// IndexedDB cache utilities for analysis results
const DB_NAME = 'MessengerInsightsCache';
const STORE_NAME = 'cached_results';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getCache(key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
}

function setCache(key, value) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

function deleteCache(key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

// Bilingual translation dictionary
const TRANSLATIONS = {
  vi: {
    langLabel: "Tiếng Việt",
    badge: "An toàn và bảo mật trên trình duyệt",
    title: "Phân tích tin nhắn Messenger",
    subtitle: "Khám phá thống kê chi tiết các cuộc trò chuyện trên Facebook của bạn một cách an toàn. Dựng lại lịch sử tin nhắn và hiển thị bảng xếp hạng trực quan.",
    uploadTitle: "Chọn thư mục dữ liệu Messenger",
    uploadSub: "Nhấp để chọn thư mục your_facebook_activity đã giải nén của bạn.",
    uploadZipTitle: "Chọn file ZIP Messenger",
    uploadZipSub: "Chọn 1 hoặc nhiều file ZIP từ Facebook. Hỗ trợ cả file E2EE riêng (messages.zip).",
    secureTitle: "Bảo mật tuyệt đối",
    secureDesc: "Xử lý cục bộ hoàn toàn tại trình duyệt thông qua Web Worker. Không tải tệp tin nào lên máy chủ.",
    mergeTitle: "Gộp tin nhắn E2EE",
    mergeDesc: "Tự động phát hiện và gộp các cuộc trò chuyện bị phân mảnh do mã hóa đầu cuối (E2EE) hoặc phân tách tệp.",
    chartTitle: "Biểu đồ trực quan",
    chartDesc: "Trực quan hóa lượng tin nhắn trên dòng thời gian theo năm, tháng, khung giờ và các ngày trong tuần.",
    extractingZip: "Đang giải nén ZIP...",
    extractingZipDesc: "Đang tìm và giải nén các file tin nhắn JSON. Bỏ qua ảnh, video và tệp khác.",
    uploadAvatarHint: "Muốn hiển thị ảnh đại diện? Tải trang danh sách bạn bè của bạn trên Facebook về (Ctrl+S) và đặt vào cùng thư mục.",
    orDivider: "hoặc",
    scanningTitle: "Đang quét cấu trúc thư mục...",
    scanningDesc: "Trình duyệt đang quét danh sách tệp tin và phân loại các cuộc hội thoại.",
    reviewTitle: "Duyệt và gộp cuộc hội thoại",
    reviewSub: (count) => `Đã phát hiện ${count} liên hệ. Các đoạn hội thoại E2EE và thông thường trùng tên đã được tự động gộp.`,
    btnBack: "Quay lại",
    btnAnalyze: "Bắt đầu phân tích sâu",
    selectAll: (count) => `Chọn tất cả (${count})`,
    estMessages: (count) => `Tổng số tin nhắn ước tính: ${count.toLocaleString()} tin`,
    files: "tệp",
    folder: "Thư mục",
    messages: "tin nhắn",
    analyzingTitle: "Đang phân tích tin nhắn...",
    analyzingDesc: "Trình duyệt đang đọc nội dung văn bản, phân tích thời gian và tần suất từ khóa trên client.",
    totalProcessed: "Tổng số tin nhắn đã xử lý:",
    file: "Tệp:",
    reportTitle: "Báo cáo thống kê Messenger",
    activeRange: "Khoảng thời gian hoạt động:",
    btnReset: "Phân tích thư mục khác",
    cardTotalMsg: "Tổng số tin nhắn",
    cardTotalContacts: "Hội thoại đã quét",
    cardTotalMedia: "Tệp đính kèm đã gửi",
    cardTotalWords: "Tổng số từ đã gõ",
    cardTotalReactions: "Lượt bày tỏ cảm xúc",
    tabOverview: "Tổng quan",
    tabLeaderboard: "Top liên hệ",
    chartTimeline: "Lịch sử nhắn tin theo tháng",
    chartWeekly: "Hoạt động theo thứ trong tuần",
    chartHourly: "Tần suất nhắn tin theo giờ trong ngày (24 giờ)",
    mediaPhotos: "Ảnh chụp",
    mediaVideos: "Video clip",
    mediaGifs: "Ảnh động GIF",
    mediaAudio: "Tin nhắn thoại",
    mediaStickers: "Nhãn dán",
    mediaFiles: "Tài liệu",
    searchPlaceholder: "Tìm kiếm liên hệ...",
    sortByLabel: "Sắp xếp theo",
    sortMessages: "Số lượng tin nhắn",
    sortReactions: "Lượt bày tỏ cảm xúc",
    sortMedia: "Tệp đính kèm (Ảnh/Video/Audio)",
    sortWords: "Số từ gõ ra",
    sortChars: "Số ký tự gõ ra",
    btnDetail: "Xem chi tiết thống kê",
    modalReportTab: "Báo cáo thống kê",
    modalChatTab: "Lịch sử chat",
    avgChars: "Ký tự trung bình",
    firstMsgLabel: "Tin nhắn đầu:",
    lastMsgLabel: "Tin nhắn cuối:",
    durationLabel: "Khoảng thời gian:",
    mediaSent: "Media đã gửi",
    totalWords: "Tổng số từ",
    chartHourlyTitle: "Phân bố theo giờ trong ngày",
    chartTimelineTitle: "Dòng thời gian tin nhắn",
    ratioTitle: "Tỉ lệ gửi tin giữa các bên",
    topWordsTitle: "Các từ hay được nhắc đến nhất",
    noTextData: "Không có dữ liệu từ khóa văn bản.",
    chatHeader: "Hội thoại:",
    btnOlderMsgs: (count) => `Xem tin nhắn cũ hơn (${count.toLocaleString()} tin còn lại)`,
    noMessages: "Không có tin nhắn nào để hiển thị.",
    mediaAttached: "Gửi kèm:",
    you: "Bạn",
    recipient: "Đối phương",
    chatRatio: "Tỉ lệ gửi tin",
    individual: "Cá nhân",
    group: "Nhóm",
    dating: "Hẹn hò",
    page: "Trang/Bot",
    weekdays: ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'],
    quickSelect: "Chọn nhanh",
    selectAllBoth: "Chọn cả hai / Tất cả",
    selectOnlyIndividual: "Chỉ chọn cá nhân",
    selectOnlyGroup: "Chỉ chọn nhóm",
    selectOnlyDating: "Chỉ chọn hẹn hò",
    selectOnlyPage: "Chỉ chọn Trang/Bot",
    deselectAll: "Bỏ chọn tất cả",
    filterTypeLabel: "Bộ lọc loại chat",
    filterAll: "Tất cả hội thoại",
    footerAuthor: "Phát triển bởi ",
    footerSource: "Mã nguồn GitHub",
    btnExportImage: "Xuất ảnh bảng xếp hạng",
    exportModalTitle: "Xuất ảnh Bảng xếp hạng",
    exportSelectTop: "Chọn số lượng liên hệ muốn xuất:",
    exportTopOption: (n) => `Top ${n} liên hệ`,
    exportAllOption: "Tất cả liên hệ",
    exportBtnDownload: "Tải ảnh về",
    exportGenerating: "Đang tạo ảnh...",
    exportFilterLabel: "Bộ lọc",
    exportSortLabel: "Sắp xếp theo",
    exportDateRangeLabel: "Thời gian hoạt động",
    exportBtnDownloadJson: "Tải file JSON",
    cacheOptionSave: "Lưu cache kết quả",
    cacheOptionClear: "Xóa cache kết quả",
    cacheSaveSuccess: "Đã lưu kết quả phân tích vào bộ nhớ trình duyệt thành công!",
    cacheClearConfirm: "Bạn có chắc chắn muốn xóa dữ liệu đã lưu?",
    btnShowMore: (count) => `Hiển thị thêm (${count.toLocaleString()} liên hệ còn lại)`
  },
  en: {
    langLabel: "English",
    badge: "Secure & Client-Side Processing",
    title: "Messenger Insights & Counter",
    subtitle: "Discover detailed statistics of your Facebook conversations securely. Reconstruct chat history and display interactive leaderboards.",
    uploadTitle: "Select Messenger data folder",
    uploadSub: "Click to select your extracted your_facebook_activity folder.",
    uploadZipTitle: "Select Messenger ZIP files",
    uploadZipSub: "Select one or more Facebook ZIP files. Also supports separate E2EE export (messages.zip).",
    secureTitle: "Absolute Security",
    secureDesc: "Processed entirely locally in your browser via Web Worker. No files are uploaded to any server.",
    mergeTitle: "Merge E2EE Chats",
    mergeDesc: "Automatically detect and merge conversation fragments split by end-to-end encryption (E2EE) or file separation.",
    chartTitle: "Interactive Charts",
    chartDesc: "Visualize message volume over time by year, month, hour of day, and days of the week.",
    extractingZip: "Extracting ZIP...",
    extractingZipDesc: "Finding and extracting message JSON files. Skipping photos, videos, and other files.",
    uploadAvatarHint: "Want profile avatars? Save your Facebook friends page (Ctrl+S) and place it in the same folder.",
    orDivider: "or",
    scanningTitle: "Scanning directory structure...",
    scanningDesc: "Browser is reading file indexes and classifying conversations.",
    reviewTitle: "Review and merge conversations",
    reviewSub: (count) => `Detected ${count} contacts. E2EE and standard conversation folders with the same name are merged.`,
    btnBack: "Back",
    btnAnalyze: "Start deep analysis",
    selectAll: (count) => `Select all (${count})`,
    estMessages: (count) => `Estimated total messages: ${count.toLocaleString()}`,
    files: "files",
    folder: "Folder",
    messages: "messages",
    analyzingTitle: "Analyzing messages...",
    analyzingDesc: "Browser is reading text content, time frequencies, and keyword ratios on client side.",
    totalProcessed: "Total processed messages:",
    file: "File:",
    reportTitle: "Messenger Insights Report",
    activeRange: "Active date range:",
    btnReset: "Analyze another folder",
    cardTotalMsg: "Total messages",
    cardTotalContacts: "Conversations scanned",
    cardTotalMedia: "Media attachments",
    cardTotalWords: "Total words written",
    cardTotalReactions: "Total reactions",
    tabOverview: "Overview",
    tabLeaderboard: "Top contacts",
    chartTimeline: "Message history by month",
    chartWeekly: "Activity by day of week",
    chartHourly: "Hourly message frequency (24 hours)",
    mediaPhotos: "Photos",
    mediaVideos: "Videos",
    mediaGifs: "GIFs",
    mediaAudio: "Voice messages",
    mediaStickers: "Stickers",
    mediaFiles: "Documents",
    searchPlaceholder: "Search contacts...",
    sortByLabel: "Sort by",
    sortMessages: "Message count",
    sortReactions: "Reactions count",
    sortMedia: "Media attachments",
    sortWords: "Words written",
    sortChars: "Characters written",
    btnDetail: "View conversation details",
    modalReportTab: "Insights report",
    modalChatTab: "Chat history",
    secondaryRatio: "Ratio",
    avgChars: "Average characters",
    firstMsgLabel: "First message:",
    lastMsgLabel: "Last message:",
    durationLabel: "Duration:",
    mediaSent: "Media sent",
    totalWords: "Total words",
    chartHourlyTitle: "Distribution by time of day",
    chartTimelineTitle: "Message timeline",
    ratioTitle: "Message distribution ratio",
    topWordsTitle: "Most frequently used words",
    noTextData: "No text data available.",
    chatHeader: "Conversation:",
    btnOlderMsgs: (count) => `Load older messages (${count.toLocaleString()} remaining)`,
    noMessages: "No messages to display.",
    mediaAttached: "Attachment:",
    you: "You",
    recipient: "Recipient",
    chatRatio: "Message ratio",
    individual: "Individual",
    group: "Group",
    dating: "Dating",
    page: "Page/Bot",
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    quickSelect: "Quick select",
    selectAllBoth: "Select both / All",
    selectOnlyIndividual: "Individuals only",
    selectOnlyGroup: "Groups only",
    selectOnlyDating: "Dating only",
    selectOnlyPage: "Pages only",
    deselectAll: "Clear all",
    filterTypeLabel: "Filter type",
    filterAll: "All conversations",
    footerAuthor: "Developed by ",
    footerSource: "GitHub Source Code",
    btnExportImage: "Export Leaderboard",
    exportModalTitle: "Export Leaderboard Image",
    exportSelectTop: "Select number of contacts to export:",
    exportTopOption: (n) => `Top ${n} contacts`,
    exportAllOption: "All contacts",
    exportBtnDownload: "Download Image",
    exportGenerating: "Generating image...",
    exportFilterLabel: "Filter",
    exportSortLabel: "Sorted by",
    exportDateRangeLabel: "Active date range",
    exportBtnDownloadJson: "Download JSON",
    cacheOptionSave: "Cache results",
    cacheOptionClear: "Clear cache",
    cacheSaveSuccess: "Analysis results saved to browser successfully!",
    cacheClearConfirm: "Are you sure you want to clear the cached results?",
    btnShowMore: (count) => `Show more (${count.toLocaleString()} remaining)`
  }
};

function App() {
  // Localization State
  const [lang, setLang] = useState('en');
  const t = TRANSLATIONS[lang];

  // Cache States
  const [hasCachedData, setHasCachedData] = useState(false);
  const [cachedMeta, setCachedMeta] = useState(null);
  const [showCacheMenu, setShowCacheMenu] = useState(false);
  const [isSavingCache, setIsSavingCache] = useState(false);
  const cacheMenuRef = useRef(null);

  // Navigation & Screen States: 'landing' | 'scanning' | 'merge_review' | 'analyzing' | 'dashboard'
  const [screen, setScreen] = useState('landing');

  // Scanning & Parsing States
  const [scanProgress, setScanProgress] = useState({ current: 0, total: 0, fileName: '' });
  const [analyzeProgress, setAnalyzeProgress] = useState({ currentFile: 0, total: 0, fileName: '', processedMessages: 0 });
  const [rawGroups, setRawGroups] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState(new Set());

  // Final Analyzed Data
  const [globalStats, setGlobalStats] = useState(null);
  const [analyzedGroups, setAnalyzedGroups] = useState([]);

  // Dynamic Avatar Map (parsed from Facebook friends HTML at runtime)
  const [dynamicAvatarMap, setDynamicAvatarMap] = useState({}); // name -> { img: blobUrl|null, url: string|null }
  const blobUrlsRef = useRef([]); // Track blob URLs for cleanup

  // Static Avatar Map State (fetched at runtime from public/avatar_map.json)
  const [avatarMap, setAvatarMap] = useState({});

  useEffect(() => {
    fetch('/avatar_map.json')
      .then(res => {
        if (res.ok) return res.json();
        return {};
      })
      .catch(() => ({}))
      .then(data => setAvatarMap(data || {}));
  }, []);

  // Dashboard UI States
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'leaderboard'
  const [selectedGroupDetails, setSelectedGroupDetails] = useState(null); // Selected group for Modal
  const [modalTab, setModalTab] = useState('stats'); // 'stats' | 'chat'
  const [visibleMessageCount, setVisibleMessageCount] = useState(150); // Pagination for Chat Viewer
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('messages'); // 'messages' | 'media' | 'words' | 'characters'
  const [filterType, setFilterType] = useState('all'); // 'all' | 'individual' | 'group' | 'dating'
  const [chatSortOrder, setChatSortOrder] = useState('oldest'); // 'oldest' | 'newest'
  const [statsMode, setStatsMode] = useState('general'); // 'personal' | 'general'

  // Leaderboard Image Export States
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportLimit, setExportLimit] = useState(10); // 10 | 20 | 30 | 50 | -1 (all)
  const [isExporting, setIsExporting] = useState(false);
  const [zipExtracting, setZipExtracting] = useState(false); // ZIP extraction in progress
  const [hideNames, setHideNames] = useState(false);
  const [hideAvatars, setHideAvatars] = useState(false);
  const [hideOverview, setHideOverview] = useState(false);
  const [displayLimit, setDisplayLimit] = useState(9);
  const [layoutMode, setLayoutMode] = useState('grid'); // 'grid' | 'list'
  const [customExportLimit, setCustomExportLimit] = useState('');
  const [revealedNames, setRevealedNames] = useState(new Set());
  const [showRevealDropdown, setShowRevealDropdown] = useState(false);
  const revealDropdownRef = useRef(null);

  // Leaderboard JSON Export States
  const [jsonIncludeOverview, setJsonIncludeOverview] = useState(true);
  const [jsonIncludeTimeline, setJsonIncludeTimeline] = useState(false);

  // Detail Modal Export States
  const [showDetailExportMenu, setShowDetailExportMenu] = useState(false);
  const [isExportingDetailJson, setIsExportingDetailJson] = useState(false);
  const [isExportingDetailImage, setIsExportingDetailImage] = useState(false);
  const detailReportRef = useRef(null);
  const detailExportMenuRef = useRef(null);

  // Export WYSIWYG Preview States
  const [previewScale, setPreviewScale] = useState(0.35);
  const [templateHeight, setTemplateHeight] = useState(1000);
  const previewParentRef = useRef(null);
  const exportPreviewRef = useRef(null);

  const exportAreaRef = useRef(null);
  const zipAvatarFilesRef = useRef([]); // HTML + images for avatar parsing in ZIP mode
  const [zipAvatarHtmlFile, setZipAvatarHtmlFile] = useState(null);
  const [zipAvatarImgCount, setZipAvatarImgCount] = useState(0);
  const [zipAvatarFolderName, setZipAvatarFolderName] = useState('');

  // Web Worker Reference
  const workerRef = useRef(null);

  // Render Avatar Helper
  const renderAvatar = (title, sizeClass = "w-11 h-11", textClass = "text-sm") => {
    const entry = (dynamicAvatarMap[title] || avatarMap[title]);
    let avatarSrc = entry ? entry.img : null;
    const profileUrl = entry ? entry.url : null;

    if (avatarSrc && typeof avatarSrc === 'string' && avatarSrc.startsWith('./')) {
      avatarSrc = avatarSrc.substring(1);
    }
    const initials = title ? title.slice(0, 2).toUpperCase() : '??';

    let content;
    if (avatarSrc) {
      content = (
        <div className={`${sizeClass} rounded-full relative shrink-0 overflow-hidden border border-[#CAC4D0] inline-block`}>
          <img
            src={avatarSrc}
            alt={title}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.target.style.display = 'none';
            }}
          />
          <div className="absolute inset-0 bg-[#D3E3FD] flex items-center justify-center text-[#041E49] font-extrabold -z-10">
            <span className={textClass}>{initials}</span>
          </div>
        </div>
      );
    } else {
      content = (
        <div className={`${sizeClass} rounded-full bg-[#D3E3FD] flex items-center justify-center text-[#041E49] font-extrabold shrink-0 border border-[#CAC4D0]`}>
          <span className={textClass}>{initials}</span>
        </div>
      );
    }

    if (profileUrl) {
      return (
        <a
          href={profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={lang === 'vi' ? `Xem trang cá nhân Facebook của ${title}` : `View ${title}'s Facebook profile`}
          className="shrink-0 transition-opacity hover:opacity-85 inline-block"
        >
          {content}
        </a>
      );
    }
    return content;
  };

  // Chart References

  const overallTimelineChartRef = useRef(null);
  const hourlyActivityChartRef = useRef(null);
  const dayOfWeekChartRef = useRef(null);
  const detailHourlyChartRef = useRef(null);
  const detailTimelineChartRef = useRef(null);

  // Chat viewport scroll ref
  const chatContainerRef = useRef(null);

  // Check if cache exists on load
  useEffect(() => {
    getCache('messenger_cache')
      .then(cache => {
        if (cache && cache.globalStats && cache.analyzedGroups) {
          setHasCachedData(true);
          setCachedMeta({
            timestamp: cache.timestamp,
            dateRange: cache.globalStats.dateRange,
            totalMessages: cache.globalStats.totalMessages
          });
        }
      })
      .catch(err => console.error('Error reading cache:', err));
  }, []);

  // Close any open modal/overlay on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (selectedGroupDetails) { setSelectedGroupDetails(null); return; }
        if (showExportModal) { setShowExportModal(false); return; }
        if (showCacheMenu) { setShowCacheMenu(false); return; }
        if (showRevealDropdown) { setShowRevealDropdown(false); return; }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedGroupDetails, showExportModal, showCacheMenu, showRevealDropdown]);

  // Handle click outside for cache dropdown menu, reveal names dropdown and detail export menu
  useEffect(() => {
    function handleClickOutside(event) {
      if (cacheMenuRef.current && !cacheMenuRef.current.contains(event.target)) {
        setShowCacheMenu(false);
      }
      if (revealDropdownRef.current && !revealDropdownRef.current.contains(event.target)) {
        setShowRevealDropdown(false);
      }
      if (detailExportMenuRef.current && !detailExportMenuRef.current.contains(event.target)) {
        setShowDetailExportMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Update preview scaling factor based on the preview panel client width
  useEffect(() => {
    if (!showExportModal) return;
    const updateScale = () => {
      if (previewParentRef.current) {
        const parentWidth = previewParentRef.current.clientWidth;
        const scale = Math.max(0.1, parentWidth / 1200);
        setPreviewScale(scale);
      }
    };

    const timer = setTimeout(updateScale, 100);
    window.addEventListener('resize', updateScale);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateScale);
    };
  }, [showExportModal]);

  // Dynamically measure template scroll height to adjust wrapper container size
  useEffect(() => {
    if (exportPreviewRef.current) {
      setTemplateHeight(exportPreviewRef.current.scrollHeight);
    }
  }, [showExportModal, exportLimit, hideOverview, hideNames, hideAvatars, revealedNames, layoutMode]);

  const handleOpenExportModal = () => {
    setRevealedNames(new Set());
    setShowRevealDropdown(false);
    setExportLimit(layoutMode === 'grid' ? 9 : 10);
    setCustomExportLimit('');
    setShowExportModal(true);
  };

  // Sync displayLimit & exportLimit when layoutMode changes
  useEffect(() => {
    setDisplayLimit(prev => {
      if (prev === -1) return -1;
      if (layoutMode === 'grid') {
        if (prev === 10) return 9;
        if (prev === 20) return 21;
        if (prev === 50) return 51;
        if (prev === 100) return 99;
      } else {
        if (prev === 9) return 10;
        if (prev === 21) return 20;
        if (prev === 51) return 50;
        if (prev === 99) return 100;
      }
      return prev;
    });
    setExportLimit(prev => {
      if (prev === -1) return -1;
      if (layoutMode === 'grid') {
        if (prev === 10) return 9;
        if (prev === 20) return 21;
        if (prev === 50) return 51;
        if (prev === 100) return 99;
      } else {
        if (prev === 9) return 10;
        if (prev === 21) return 20;
        if (prev === 51) return 50;
        if (prev === 99) return 100;
      }
      return prev;
    });
  }, [layoutMode]);

  const handleExportImage = async () => {
    if (!exportAreaRef.current) return;
    setIsExporting(true);
    // Let DOM update and style settle
    await new Promise(resolve => setTimeout(resolve, 600));
    try {
      const canvas = await html2canvas(exportAreaRef.current, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#F8FAFC',
        scale: 2, // Retain details on high density screens
        logging: false
      });
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = `messenger_leaderboard_top_${exportLimit === -1 ? 'all' : exportLimit}.png`;
      link.href = dataUrl;
      link.click();
      setShowExportModal(false);
    } catch (error) {
      console.error('Failed to export image', error);
      alert(lang === 'vi' ? 'Lỗi khi xuất ảnh. Vui lòng thử lại!' : 'Failed to generate image. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportJson = () => {
    const leaderboard = filteredAndSortedGroups
      .slice(0, exportLimit === -1 ? undefined : exportLimit)
      .map((group, index) => {
        const totalMedia = Object.values(group.mediaCounts).reduce((acc, val) => acc + val, 0);
        const displayName = hideNames
          ? (revealedNames.has(group.title)
            ? group.title
            : (lang === 'vi' ? `Liên hệ #${index + 1}` : `Contact #${index + 1}`))
          : group.title;
        
        const item = {
          rank: index + 1,
          title: displayName,
          type: group.type,
          messageCount: group.messageCount,
          reactionCount: group.reactionCount || 0,
          mediaCount: totalMedia,
          wordCount: group.totalWords,
          characterCount: group.totalCharacters,
          firstMessage: group.dateRange?.start || null,
          lastMessage: group.dateRange?.end || null
        };

        if (jsonIncludeTimeline) {
          item.timeline = {
            monthly: group.monthlyCounts,
            hourly: group.hourlyCounts
          };
        }

        return item;
      });

    let exportData = leaderboard;

    if (jsonIncludeOverview) {
      exportData = {
        overview: {
          totalMessages: statsMode === 'personal' ? globalStats.personal.totalMessages : globalStats.totalMessages,
          totalReactions: statsMode === 'personal' ? globalStats.personal.totalReactions : globalStats.totalReactions,
          totalContacts: analyzedGroups.length,
          totalMedia: statsMode === 'personal' ? globalStats.personal.totalMedia : globalStats.totalMedia,
          totalWords: statsMode === 'personal' ? globalStats.personal.totalWords : globalStats.totalWords,
          totalCharacters: statsMode === 'personal' ? globalStats.personal.totalCharacters : globalStats.totalCharacters,
          dateRange: globalStats.dateRange
        },
        leaderboard
      };
    }

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const link = document.createElement('a');
    link.download = `messenger_leaderboard_top_${exportLimit === -1 ? 'all' : exportLimit}.json`;
    link.href = dataStr;
    link.click();
    setShowExportModal(false);
  };

  const handleExportDetailJson = (format) => {
    if (!workerRef.current || !selectedGroupDetails) return;
    setIsExportingDetailJson(true);
    workerRef.current.postMessage({
      type: 'EXPORT_CHAT_JSON',
      data: {
        fileIndices: selectedGroupDetails.files.map(f => f.fileIndex),
        title: selectedGroupDetails.title,
        format
      }
    });
  };

  const handleDownloadDetailJsonComplete = (data) => {
    const { title, jsonContent, format } = data;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jsonContent, null, 2));
    const link = document.createElement('a');
    link.download = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_messages_${format}.json`;
    link.href = dataStr;
    link.click();
    setIsExportingDetailJson(false);
    setShowDetailExportMenu(false);
  };

  const handleExportDetailImage = async () => {
    if (!detailReportRef.current || !selectedGroupDetails) return;
    setIsExportingDetailImage(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      const canvas = await html2canvas(detailReportRef.current, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#F8FAFC',
        scale: 2,
        logging: false
      });
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const sanitizedTitle = selectedGroupDetails.title.toLowerCase().replace(/[^a-z0-9]/g, '_');
      link.download = `${sanitizedTitle}_stats_report.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error('Failed to export details image', error);
      alert(lang === 'vi' ? 'Lỗi khi xuất ảnh chi tiết. Vui lòng thử lại!' : 'Failed to export details image. Please try again.');
    } finally {
      setIsExportingDetailImage(false);
    }
  };

  const handleLoadCache = async () => {
    try {
      const cache = await getCache('messenger_cache');
      if (cache && cache.globalStats && cache.analyzedGroups) {
        setGlobalStats(cache.globalStats);
        setAnalyzedGroups(cache.analyzedGroups);

        // Restore dynamic avatars by recreating browser Blob URLs
        if (cache.dynamicAvatarMap) {
          const restoredMap = {};
          const newBlobUrls = [];

          for (const [name, entry] of Object.entries(cache.dynamicAvatarMap)) {
            let newImgUrl = null;
            if (entry.rawBlob) {
              newImgUrl = URL.createObjectURL(entry.rawBlob);
              newBlobUrls.push(newImgUrl);
            } else if (entry.img && !entry.img.startsWith('blob:')) {
              newImgUrl = entry.img;
            }
            restoredMap[name] = {
              img: newImgUrl,
              url: entry.url,
              rawBlob: entry.rawBlob
            };
          }

          blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
          blobUrlsRef.current = newBlobUrls;
          setDynamicAvatarMap(restoredMap);
        }

        setScreen('dashboard');
      }
    } catch (err) {
      console.error('Failed to load cache:', err);
      alert(lang === 'vi' ? 'Lỗi khi tải cache. Vui lòng thử lại!' : 'Failed to load cache. Please try again.');
    }
  };

  const handleClearCache = async () => {
    if (window.confirm(lang === 'vi' ? t.cacheClearConfirm : 'Are you sure you want to clear the cached results?')) {
      try {
        await deleteCache('messenger_cache');
        setHasCachedData(false);
        setCachedMeta(null);
        setShowCacheMenu(false);
      } catch (err) {
        console.error('Failed to clear cache:', err);
      }
    }
  };

  const handleSaveCache = async () => {
    if (!globalStats || !analyzedGroups) return;
    try {
      setIsSavingCache(true);
      await setCache('messenger_cache', {
        globalStats,
        analyzedGroups,
        dynamicAvatarMap,
        timestamp: Date.now()
      });
      setHasCachedData(true);
      setCachedMeta({
        timestamp: Date.now(),
        dateRange: globalStats.dateRange,
        totalMessages: globalStats.totalMessages
      });
      setShowCacheMenu(false);
      alert(lang === 'vi'
        ? t.cacheSaveSuccess
        : 'Analysis results successfully saved to browser cache!'
      );
    } catch (err) {
      console.error('Failed to save cache:', err);
      alert(lang === 'vi' ? 'Lỗi khi lưu cache. Vui lòng thử lại!' : 'Failed to save cache. Please try again.');
    } finally {
      setIsSavingCache(false);
    }
  };

  // Initialize Web Worker
  useEffect(() => {
    workerRef.current = new Worker(new URL('/worker.js', import.meta.url));

    workerRef.current.onmessage = (e) => {
      const { type, data } = e.data;

      switch (type) {
        case 'SCAN_PROGRESS':
          setScanProgress(data);
          break;
        case 'SCAN_COMPLETE':
          setRawGroups(data.groups);
          const allIds = data.groups.map(g => g.id);
          setSelectedGroups(new Set(allIds));
          setScreen('merge_review');
          break;
        case 'ANALYZE_PROGRESS':
          setAnalyzeProgress(prev => ({
            ...prev,
            currentFile: data.currentFile,
            fileName: data.fileName,
            processedMessages: data.processedMessages
          }));
          break;
        case 'ANALYZE_COMPLETE':
          setGlobalStats(data.globalStats);
          setAnalyzedGroups(data.groups);
          setScreen('dashboard');
          break;
        case 'EXPORT_CHAT_JSON_COMPLETE':
          handleDownloadDetailJsonComplete(data);
          break;
        default:
          break;
      }
    };

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, []);

  // Parse a Facebook Friends saved HTML page to extract name → { img blob url, profile url }
  const parseFacebookFriendsHtml = async (htmlFile, imageFiles) => {
    try {
      const htmlText = await htmlFile.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');

      // Build a quick lookup: image filename → File object
      const imageFileMap = {};
      imageFiles.forEach(f => {
        imageFileMap[f.name] = f;
      });

      const result = {};
      const profileRegex = /^https:\/\/www\.facebook\.com\/([^?#]+|profile\.php\?id=\d+)/;

      // Collect profileId → { img filename, name }
      const profileMap = {};

      // Scan all anchors
      const anchors = doc.querySelectorAll('a[href]');
      anchors.forEach(a => {
        const href = a.getAttribute('href') || '';
        const match = profileRegex.exec(href);
        if (!match) return;
        const profileId = match[1];

        if (!profileMap[profileId]) profileMap[profileId] = { img: null, name: null };
        const info = profileMap[profileId];

        // Check for image inside this anchor
        const img = a.querySelector('img[src]');
        if (img && !info.img) {
          const src = img.getAttribute('src') || '';
          // Extract just the filename part
          const filename = src.split('/').pop().split('?')[0];
          if (filename && imageFileMap[filename]) {
            info.img = filename;
          }
        }

        // Check for name text
        if (!info.name) {
          const spanDir = a.querySelector('[dir="auto"]');
          if (spanDir && spanDir.textContent.trim()) {
            info.name = spanDir.textContent.trim();
          } else {
            const txt = a.textContent.replace(/\s+/g, ' ').trim();
            if (txt && !txt.startsWith('http') && txt.length < 100) {
              info.name = txt;
            }
          }
        }
      });

      // Build blob URL map
      const newBlobUrls = [];
      for (const [profileId, info] of Object.entries(profileMap)) {
        if (!info.name) continue;
        let blobUrl = null;
        let rawBlob = null;
        if (info.img && imageFileMap[info.img]) {
          const file = imageFileMap[info.img];
          try {
            const arrayBuffer = await file.arrayBuffer();
            rawBlob = new Blob([arrayBuffer], { type: file.type });
            blobUrl = URL.createObjectURL(rawBlob);
            newBlobUrls.push(blobUrl);
          } catch (e) {
            console.error('Failed to read image file into blob', e);
          }
        }
        result[info.name] = {
          img: blobUrl,
          url: `https://www.facebook.com/${profileId}`,
          rawBlob: rawBlob
        };
      }

      // Cleanup old blob URLs
      blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
      blobUrlsRef.current = newBlobUrls;

      return result;
    } catch (err) {
      console.error('Failed to parse Facebook friends HTML:', err);
      return {};
    }
  };

  // Helper handlers for ZIP avatar parsing flow
  const handleHtmlFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setZipAvatarHtmlFile(file);
    setZipAvatarImgCount(0);
    
    // Calculate expected folder name
    const baseName = file.name.replace(/\.html?$/i, '');
    const expectedFolder = `${baseName}_files`;
    setZipAvatarFolderName(expectedFolder);

    zipAvatarFilesRef.current = [file];

    // Automatically open folder picker
    const folderInput = document.getElementById('zip-avatar-folder-upload');
    if (folderInput) {
      folderInput.click();
    }
  };

  const handleFolderChange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    const htmlFiles = files.filter(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
    const imageFiles = files.filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f.name));

    let currentHtml = zipAvatarHtmlFile;
    if (htmlFiles.length > 0) {
      currentHtml = htmlFiles[0];
      setZipAvatarHtmlFile(htmlFiles[0]);
    }

    setZipAvatarImgCount(imageFiles.length);

    if (currentHtml) {
      zipAvatarFilesRef.current = [currentHtml, ...imageFiles];
    } else {
      zipAvatarFilesRef.current = imageFiles;
    }
  };

  // Handler: Selecting folder
  const handleFolderSelect = async (e) => {
    const files = Array.from(e.target.files);

    // Detect Facebook friends HTML file (saved web page)
    const htmlFiles = files.filter(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
    // Detect companion image files (inside *_files/ subdirectory)
    const imageFiles = files.filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f.name));

    // If a friends HTML is present, parse it in the background
    if (htmlFiles.length > 0 && imageFiles.length > 0) {
      parseFacebookFriendsHtml(htmlFiles[0], imageFiles).then(parsed => {
        if (Object.keys(parsed).length > 0) {
          setDynamicAvatarMap(parsed);
          console.log(`[Avatar] Parsed ${Object.keys(parsed).length} friends from ${htmlFiles[0].name}`);
        }
      });
    }

    // Filter JSON files containing messages / dating
    const messageFileRegex = /(messages[\/\\](inbox|e2ee_cutover|archived_threads|message_requests|filtered_threads|extracted)?[\/\\]|dating[\/\\]messages[\/\\]).*\.json$/i;
    const filteredFiles = files.filter(f => messageFileRegex.test(f.webkitRelativePath || f.name));

    if (filteredFiles.length === 0) {
      alert(lang === 'vi'
        ? "Không tìm thấy tệp dữ liệu tin nhắn JSON hợp lệ. Vui lòng chọn đúng thư mục 'your_facebook_activity'."
        : "No valid JSON message files found. Please select your 'your_facebook_activity' folder."
      );
      return;
    }

    setScreen('scanning');
    setScanProgress({ current: 0, total: filteredFiles.length, fileName: lang === 'vi' ? 'Đang bắt đầu quét...' : 'Starting scan...' });

    workerRef.current.postMessage({
      type: 'SCAN_FILES',
      data: { files: filteredFiles }
    });
  };

  // Handler: Selecting ZIP files (fflate streaming — never loads full ZIP into RAM)
  const handleZipSelect = async (e) => {
    const zipFiles = Array.from(e.target.files);
    if (zipFiles.length === 0) return;

    setZipExtracting(true);
    setScreen('scanning');
    setScanProgress({ current: 0, total: 0, fileName: lang === 'vi' ? 'Chuẩn bị giải nén...' : 'Preparing to extract...' });

    const allBlobs = [];
    for (let i = 0; i < zipFiles.length; i++) {
      const zipFile = zipFiles[i];
      try {
        const blobs = await extractJsonsFromZip(zipFile, (extracted, fileName) => {
          setScanProgress({
            current: extracted,
            total: extracted, // total unknown while streaming
            fileName: `[${i + 1}/${zipFiles.length}] ${zipFile.name} → ${fileName}`
          });
        });
        allBlobs.push(...blobs);
      } catch (err) {
        console.error(`Failed to extract ${zipFile.name}:`, err);
        alert(`${lang === 'vi' ? 'Lỗi khi giải nén' : 'Error extracting'} ${zipFile.name}`);
      }
    }

    setZipExtracting(false);

    // Parse avatar HTML if user provided one alongside the ZIPs
    const avatarFiles = zipAvatarFilesRef.current;
    if (avatarFiles.length > 0) {
      const htmlFiles = avatarFiles.filter(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
      const imageFiles = avatarFiles.filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f.name));
      if (htmlFiles.length > 0 && imageFiles.length > 0) {
        parseFacebookFriendsHtml(htmlFiles[0], imageFiles).then(parsed => {
          if (Object.keys(parsed).length > 0) {
            setDynamicAvatarMap(parsed);
            console.log(`[Avatar/ZIP] Parsed ${Object.keys(parsed).length} friends from ${htmlFiles[0].name}`);
          }
        });
      }
    }

    if (allBlobs.length === 0) {
      alert(lang === 'vi'
        ? 'Không tìm thấy file JSON tin nhắn trong các file ZIP đã chọn. Hãy kiểm tra lại các file ZIP.'
        : 'No message JSON files found in the selected ZIP files. Please check the ZIP files.'
      );
      setScreen('landing');
      return;
    }

    setScanProgress({ current: 0, total: allBlobs.length, fileName: lang === 'vi' ? 'Đang bắt đầu quét...' : 'Starting scan...' });
    workerRef.current.postMessage({
      type: 'SCAN_FILES',
      data: { files: allBlobs }
    });
  };

  // Trigger Deep Analysis
  const handleStartAnalysis = () => {
    if (selectedGroups.size === 0) {
      alert(lang === 'vi'
        ? "Vui lòng chọn ít nhất một cuộc hội thoại để phân tích."
        : "Please select at least one conversation to analyze."
      );
      return;
    }

    setScreen('analyzing');
    setAnalyzeProgress({ currentFile: 0, total: selectedGroups.size, fileName: lang === 'vi' ? 'Khởi tạo phân tích...' : 'Initializing analysis...', processedMessages: 0 });

    workerRef.current.postMessage({
      type: 'ANALYZE_GROUPS',
      data: {
        selectedGroupIds: Array.from(selectedGroups),
        mergeConfig: {}
      }
    });
  };

  // Helper: Toggle group selection
  const toggleGroupSelection = (groupId) => {
    const next = new Set(selectedGroups);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
    }
    setSelectedGroups(next);
  };

  const toggleAllGroups = (checked) => {
    if (checked) {
      setSelectedGroups(new Set(rawGroups.map(g => g.id)));
    } else {
      setSelectedGroups(new Set());
    }
  };

  // Quick select methods for Merge Review
  const selectOnlyType = (typeKey) => {
    const next = new Set();
    rawGroups.forEach(g => {
      if (g.type === typeKey) {
        next.add(g.id);
      }
    });
    setSelectedGroups(next);
  };

  const selectAllTypes = () => {
    setSelectedGroups(new Set(rawGroups.map(g => g.id)));
  };

  const selectNone = () => {
    setSelectedGroups(new Set());
  };

  const formatDateRange = (range) => {
    if (!range || !range.start || !range.end) return 'N/A';
    const start = new Date(range.start).toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', { year: 'numeric', month: 'short' });
    const end = new Date(range.end).toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', { year: 'numeric', month: 'short' });
    return `${start} - ${end}`;
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const isE2EEMerged = (group) => {
    const hasInbox = group.files.some(f => f.filePath.toLowerCase().includes('/inbox/') || f.filePath.toLowerCase().includes('\\inbox\\'));
    const hasE2EE = group.files.some(f =>
      f.filePath.toLowerCase().includes('/e2ee_cutover/') ||
      f.filePath.toLowerCase().includes('\\e2ee_cutover\\') ||
      f.filePath.toLowerCase().includes('/extracted/') ||
      f.filePath.toLowerCase().includes('\\extracted\\') ||
      f.fileName.match(/_\d+\.json$/i)
    );
    return hasInbox && hasE2EE;
  };

  const getE2EELabel = (group) => {
    const hasInbox = group.files.some(f => f.filePath.toLowerCase().includes('/inbox/') || f.filePath.toLowerCase().includes('\\inbox\\'));
    const hasE2EE = group.files.some(f =>
      f.filePath.toLowerCase().includes('/e2ee_cutover/') ||
      f.filePath.toLowerCase().includes('\\e2ee_cutover\\') ||
      f.filePath.toLowerCase().includes('/extracted/') ||
      f.filePath.toLowerCase().includes('\\extracted\\') ||
      f.fileName.match(/_\d+\.json$/i)
    );
    if (hasInbox && hasE2EE) {
      return lang === 'vi' ? `Đã gộp E2EE & Thường (${group.files.length} tệp)` : `E2EE & Standard merged (${group.files.length} files)`;
    }
    if (hasE2EE) {
      return lang === 'vi' ? `Tin nhắn E2EE (${group.files.length} tệp)` : `E2EE Messages (${group.files.length} files)`;
    }
    return null;
  };

  const isCurrentUser = (senderName) => {
    if (!senderName) return false;
    // Use auto-detected owner name from analysis
    if (globalStats && globalStats.myName) {
      return senderName === globalStats.myName;
    }
    // Fallback: generic markers only
    const normalized = senderName.toLowerCase();
    return normalized === 'bạn' || normalized === 'you';
  };

  const formatMsgTime = (timestampMs) => {
    if (!timestampMs) return '';
    const date = new Date(timestampMs);
    const time = date.toLocaleTimeString(lang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    const day = date.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit', year: '2-digit' });
    return `${time} - ${day}`;
  };

  const formatFirstMessageDate = (start) => {
    if (!start) return 'N/A';
    const date = new Date(start);
    return date.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const formatLastMessageDaysAgo = (end) => {
    if (!end) return 'N/A';
    const diffMs = Date.now() - end;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) {
      return lang === 'vi' ? 'Hôm nay' : 'Today';
    }
    return lang === 'vi' ? `${diffDays} ngày trước` : `${diffDays} days ago`;
  };

  const formatDuration = (start, end) => {
    if (!start || !end) return 'N/A';
    const diffMs = end - start;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 30) {
      return lang === 'vi' ? `${diffDays} ngày` : `${diffDays} days`;
    }

    const years = Math.floor(diffDays / 365);
    const remainingDaysAfterYears = diffDays % 365;
    const months = Math.floor(remainingDaysAfterYears / 30);
    const days = remainingDaysAfterYears % 30;

    let parts = [];
    if (lang === 'vi') {
      if (years > 0) parts.push(`${years} năm`);
      if (months > 0) parts.push(`${months} tháng`);
      if (years === 0 && months === 0 && days > 0) parts.push(`${days} ngày`);
      return parts.join(' ');
    } else {
      if (years > 0) parts.push(`${years} year${years > 1 ? 's' : ''}`);
      if (months > 0) parts.push(`${months} month${months > 1 ? 's' : ''}`);
      if (years === 0 && months === 0 && days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
      return parts.join(' ');
    }
  };

  const handleReset = () => {
    setScreen('landing');
    setRawGroups([]);
    setSelectedGroups(new Set());
    setGlobalStats(null);
    setAnalyzedGroups([]);
    setSelectedGroupDetails(null);
    setModalTab('stats');
    setVisibleMessageCount(150);
    setFilterType('all');
    // Cleanup blob URLs from dynamic avatar parsing
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
    blobUrlsRef.current = [];
    setDynamicAvatarMap({});
  };

  const getTranslatedChatType = (type) => {
    if (type === CHAT_TYPES.INDIVIDUAL) return t.individual;
    if (type === CHAT_TYPES.GROUP) return t.group;
    if (type === CHAT_TYPES.DATING) return t.dating;
    if (type === CHAT_TYPES.PAGE) return t.page;
    return type;
  };

  // ==================== RENDERING CHARTS IN DASHBOARD ====================
  useEffect(() => {
    if (screen !== 'dashboard' || !globalStats || activeTab !== 'overview') return;

    let timelineChart = null;
    let hourlyChart = null;
    let dayOfWeekChart = null;

    const currentGlobal = statsMode === 'personal' ? globalStats.personal : globalStats;

    if (overallTimelineChartRef.current) {
      const sortedMonths = Object.entries(currentGlobal.monthlyCounts)
        .sort((a, b) => a[0].localeCompare(b[0]));

      const labels = sortedMonths.map(m => m[0]);
      const data = sortedMonths.map(m => m[1]);

      timelineChart = new Chart(overallTimelineChartRef.current.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: t.sortMessages,
            data: data,
            borderColor: '#0B57D0',
            backgroundColor: 'rgba(103, 80, 164, 0.08)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: labels.length > 50 ? 0 : 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          plugins: {
            legend: { display: false },
            zoom: {
              zoom: {
                wheel: {
                  enabled: true,
                  modifierKey: 'ctrl'
                },
                pinch: {
                  enabled: true
                },
                mode: 'x'
              },
              pan: {
                enabled: true,
                mode: 'x'
              }
            }
          },
          scales: {
            x: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F' } },
            y: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F' } }
          }
        }
      });
    }

    if (hourlyActivityChartRef.current) {
      hourlyChart = new Chart(hourlyActivityChartRef.current.getContext('2d'), {
        type: 'bar',
        data: {
          labels: Array.from({ length: 24 }, (_, i) => `${i}h`),
          datasets: [{
            label: t.sortMessages,
            data: currentGlobal.hourlyCounts,
            backgroundColor: '#0B57D0',
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#49454F' } },
            y: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F' } }
          }
        }
      });
    }

    if (dayOfWeekChartRef.current) {
      dayOfWeekChart = new Chart(dayOfWeekChartRef.current.getContext('2d'), {
        type: 'bar',
        data: {
          labels: t.weekdays,
          datasets: [{
            label: t.sortMessages,
            data: currentGlobal.dayOfWeekCounts,
            backgroundColor: '#625B71',
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#49454F' } },
            y: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F' } }
          }
        }
      });
    }

    return () => {
      if (timelineChart) timelineChart.destroy();
      if (hourlyChart) hourlyChart.destroy();
      if (dayOfWeekChart) dayOfWeekChart.destroy();
    };
  }, [screen, globalStats, activeTab, lang, statsMode]);

  // ==================== RENDERING CHARTS IN MODAL DETAILS ====================
  useEffect(() => {
    if (!selectedGroupDetails || modalTab !== 'stats') return;

    let detHourlyChart = null;
    let detTimelineChart = null;

    const currentDetails = statsMode === 'personal' ? selectedGroupDetails.personal : selectedGroupDetails;

    if (detailHourlyChartRef.current) {
      detHourlyChart = new Chart(detailHourlyChartRef.current.getContext('2d'), {
        type: 'bar',
        data: {
          labels: Array.from({ length: 24 }, (_, i) => `${i}h`),
          datasets: [{
            label: t.sortMessages,
            data: currentDetails.hourlyCounts,
            backgroundColor: '#0B57D0',
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#49454F', font: { size: 10 } } },
            y: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F', font: { size: 10 } } }
          }
        }
      });
    }

    if (detailTimelineChartRef.current) {
      const sortedMonths = Object.entries(currentDetails.monthlyCounts)
        .sort((a, b) => a[0].localeCompare(b[0]));

      const labels = sortedMonths.map(m => m[0]);
      const data = sortedMonths.map(m => m[1]);

      detTimelineChart = new Chart(detailTimelineChartRef.current.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: t.sortMessages,
            data: data,
            borderColor: '#625B71',
            backgroundColor: 'rgba(98, 91, 113, 0.05)',
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: labels.length > 50 ? 0 : 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            mode: 'index',
            intersect: false
          },
          plugins: {
            legend: { display: false },
            zoom: {
              zoom: {
                wheel: {
                  enabled: true,
                  modifierKey: 'ctrl'
                },
                pinch: {
                  enabled: true
                },
                mode: 'x'
              },
              pan: {
                enabled: true,
                mode: 'x'
              }
            }
          },
          scales: {
            x: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F', font: { size: 10 } } },
            y: { grid: { color: '#E7E0EC' }, ticks: { color: '#49454F', font: { size: 10 } } }
          }
        }
      });
    }

    return () => {
      if (detHourlyChart) detHourlyChart.destroy();
      if (detTimelineChart) detTimelineChart.destroy();
    };
  }, [selectedGroupDetails, modalTab, lang, statsMode]);

  // Scroll to bottom
  useEffect(() => {
    if (modalTab === 'chat' && chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [modalTab, selectedGroupDetails, visibleMessageCount]);

  // Filter & Sort Leaderboard
  const filteredAndSortedGroups = analyzedGroups
    .filter(g => g.title.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter(g => {
      if (filterType === 'all') return true;
      if (filterType === 'individual') return g.type === CHAT_TYPES.INDIVIDUAL;
      if (filterType === 'group') return g.type === CHAT_TYPES.GROUP;
      if (filterType === 'dating') return g.type === CHAT_TYPES.DATING;
      if (filterType === 'page') return g.type === CHAT_TYPES.PAGE;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'messages') return b.messageCount - a.messageCount;
      if (sortBy === 'reactions') return (b.reactionCount || 0) - (a.reactionCount || 0);
      if (sortBy === 'media') {
        const sumMedia = (group) => Object.values(group.mediaCounts).reduce((acc, val) => acc + val, 0);
        return sumMedia(b) - sumMedia(a);
      }
      if (sortBy === 'words') return b.totalWords - a.totalWords;
      if (sortBy === 'characters') return b.totalCharacters - a.totalCharacters;
      return 0;
    });

  const allIds = rawGroups.map(g => g.id);
  const isAllSelected = selectedGroups.size === rawGroups.length && rawGroups.length > 0;
  const isNoneSelected = selectedGroups.size === 0;

  const individualIds = rawGroups.filter(g => g.type === CHAT_TYPES.INDIVIDUAL).map(g => g.id);
  const isOnlyIndividualSelected = individualIds.length > 0 &&
    selectedGroups.size === individualIds.length &&
    individualIds.every(id => selectedGroups.has(id));

  const groupIds = rawGroups.filter(g => g.type === CHAT_TYPES.GROUP).map(g => g.id);
  const isOnlyGroupSelected = groupIds.length > 0 &&
    selectedGroups.size === groupIds.length &&
    groupIds.every(id => selectedGroups.has(id));

  const datingIds = rawGroups.filter(g => g.type === CHAT_TYPES.DATING).map(g => g.id);
  const isOnlyDatingSelected = datingIds.length > 0 &&
    selectedGroups.size === datingIds.length &&
    datingIds.every(id => selectedGroups.has(id));

  const pageIds = rawGroups.filter(g => g.type === CHAT_TYPES.PAGE).map(g => g.id);
  const isOnlyPageSelected = pageIds.length > 0 &&
    selectedGroups.size === pageIds.length &&
    pageIds.every(id => selectedGroups.has(id));

  const renderExportTemplateContent = () => {
    return (
      <>
        {/* Dashboard Header */}
        <div className="flex flex-row items-center justify-between gap-4 mb-2 border-b border-[#CAC4D0] pb-6">
          <div>
            <h1 className="text-3xl font-extrabold text-[#1D1B20] flex items-center gap-3">
              <BarChart2 className="w-8 h-8 text-[#0B57D0]" />
              <span>
                {lang === 'vi' ? (
                  <>Báo cáo thống kê <span className="text-[#0B57D0]">Messenger</span></>
                ) : (
                  <><span className="text-[#0B57D0]">Messenger</span> Insights Report</>
                )}
              </span>
            </h1>
            <p className="text-sm text-[#49454F] mt-1">
              {t.activeRange} <span className="text-[#0B57D0] font-bold">{formatDateRange(globalStats?.dateRange)}</span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Stats Mode Toggle Visual */}
            <div className="flex items-center gap-1 bg-[#E9EEF6] p-1 rounded-full border border-[#CAC4D0] shadow-sm">
              <span className={`px-4 py-2 rounded-full text-xs font-bold ${statsMode === 'personal' ? 'bg-[#0B57D0] text-white shadow-sm' : 'text-[#49454F]'}`}>
                {lang === 'vi' ? 'Cá nhân' : 'Personal'}
              </span>
              <span className={`px-4 py-2 rounded-full text-xs font-bold ${statsMode === 'general' ? 'bg-[#0B57D0] text-white shadow-sm' : 'text-[#49454F]'}`}>
                {lang === 'vi' ? 'Chung' : 'General'}
              </span>
            </div>
          </div>
        </div>

        {/* Stat Cards Grid (Overview Summary) - rendered unless hideOverview is checked */}
        {!hideOverview && (
          <div className="grid grid-cols-5 gap-6 mb-2">
            <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
              <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                <MessageSquare className="w-12 h-12" />
              </div>
              <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalMsg}</span>
              <div className="text-3xl font-black text-[#0B57D0] mt-2 font-mono">
                {(statsMode === 'personal' ? globalStats?.personal?.totalMessages : globalStats?.totalMessages).toLocaleString()}
              </div>
              <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Xử lý an toàn' : 'Processed securely'}</div>
            </div>

            <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
              <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                <Sparkles className="w-12 h-12" />
              </div>
              <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalReactions}</span>
              <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                {((statsMode === 'personal' ? globalStats?.personal?.totalReactions : globalStats?.totalReactions) || 0).toLocaleString()}
              </div>
              <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Lượt bày tỏ cảm xúc' : 'Total reactions'}</div>
            </div>

            <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
              <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                <Users className="w-12 h-12" />
              </div>
              <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalContacts}</span>
              <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                {analyzedGroups.length.toLocaleString()}
              </div>
              <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Đã gộp các tệp E2EE' : 'E2EE folders merged'}</div>
            </div>

            <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
              <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                <Image className="w-12 h-12" />
              </div>
              <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalMedia}</span>
              <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                {(statsMode === 'personal' ? globalStats?.personal?.totalMedia : globalStats?.totalMedia).toLocaleString()}
              </div>
              <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Ảnh, video, thoại, tệp' : 'Photos, videos, audio, files'}</div>
            </div>

            <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
              <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                <FileText className="w-12 h-12" />
              </div>
              <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalWords}</span>
              <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                {(statsMode === 'personal' ? globalStats?.personal?.totalWords : globalStats?.totalWords).toLocaleString()}
              </div>
              <div className="text-xs text-[#625B71] mt-1">
                {lang === 'vi' ? `Ký tự: ${(statsMode === 'personal' ? globalStats?.personal?.totalCharacters : globalStats?.totalCharacters).toLocaleString()}` : `Chars: ${(statsMode === 'personal' ? globalStats?.personal?.totalCharacters : globalStats?.totalCharacters).toLocaleString()}`}
              </div>
            </div>
          </div>
        )}

        {/* Contacts Grid or List */}
        {layoutMode === 'list' ? (
          <div className="flex flex-col gap-4 font-sans">
            {filteredAndSortedGroups
              .slice(0, exportLimit === -1 ? undefined : exportLimit)
              .map((group, index) => {
                const currentGroupStats = group;
                const totalMedia = Object.values(currentGroupStats.mediaCounts).reduce((acc, val) => acc + val, 0);

                const isDm = group.participants && group.participants.length === 2;
                let ratioLabel1 = '';
                let ratioPercent1 = 50;

                if (isDm) {
                  const myName = (globalStats && globalStats.myName) || 'Bạn';
                  const otherParticipant = group.participants.find(p => p !== myName);
                  const senderNames = Object.keys(group.senderCounts);
                  const mySenderName = senderNames.find(n => n === myName) || myName;
                  const friendName = senderNames.find(n => n !== mySenderName) || otherParticipant || 'Liên hệ';
                  const myCount = group.senderCounts[mySenderName] || 0;

                  ratioPercent1 = group.messageCount > 0 ? Math.round((myCount / group.messageCount) * 100) : 50;
                  ratioLabel1 = `${t.you}: ${ratioPercent1}% / ${t.recipient}: ${100 - ratioPercent1}%`;
                }

                const displayName = hideNames
                  ? (revealedNames.has(group.title)
                    ? group.title
                    : (lang === 'vi' ? `Liên hệ #${index + 1}` : `Contact #${index + 1}`))
                  : group.title;

                return (
                  <div
                    key={group.id}
                    className="flex flex-row items-center justify-between gap-4 p-4.5 rounded-[24px] bg-[#F0F4F9] border border-[#CAC4D0] w-full"
                  >
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                      {/* Rank */}
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white border border-[#CAC4D0] text-xs text-[#1D1B20] font-extrabold shrink-0 shadow-sm">
                        #{index + 1}
                      </div>
                      {/* Avatar */}
                      {hideAvatars && !revealedNames.has(group.title) ? (
                        <div className="w-10 h-10 rounded-full bg-[#E9EEF6] border border-[#CAC4D0] flex items-center justify-center text-[#49454F] shrink-0 font-bold">
                          <User className="w-5 h-5 text-[#625B71]" />
                        </div>
                      ) : (
                        renderAvatar(group.title, "w-10 h-10", "text-xs")
                      )}
                      {/* Name & Type */}
                      <div className="min-w-0">
                        {avatarMap[group.title]?.url && (!hideNames || revealedNames.has(group.title)) ? (
                          <span className="font-extrabold text-[#0B57D0] truncate text-sm block">
                            {displayName}
                          </span>
                        ) : (
                          <h4 className="font-extrabold text-[#1D1B20] truncate text-sm">{displayName}</h4>
                        )}
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                            {getTranslatedChatType(group.type)}
                          </span>
                          {getE2EELabel(group) && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                              E2EE
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Stats Summary columns */}
                    <div className="grid grid-cols-4 gap-6 text-xs text-[#49454F] font-semibold w-[420px]">
                      <div>
                        <span className="block text-[9px] text-[#625B71] uppercase font-bold">{t.sortMessages}</span>
                        <span className="text-sm font-bold text-[#1D1B20] font-mono">{currentGroupStats.messageCount.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] text-[#625B71] uppercase font-bold">{lang === 'vi' ? 'Cảm xúc' : 'Reactions'}</span>
                        <span className="text-sm font-bold text-[#1D1B20] font-mono">{(currentGroupStats.reactionCount || 0).toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] text-[#625B71] uppercase font-bold">Media</span>
                        <span className="text-sm font-bold text-[#1D1B20] font-mono">{totalMedia.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] text-[#625B71] uppercase font-bold">{lang === 'vi' ? 'Từ vựng' : 'Words'}</span>
                        <span className="text-sm font-bold text-[#1D1B20] font-mono">{currentGroupStats.totalWords.toLocaleString()}</span>
                      </div>
                    </div>

                    {/* Split Ratio */}
                    {isDm && ratioLabel1 && (
                      <div className="w-24">
                        <div className="flex justify-between text-[9px] text-[#49454F] mb-0.5 font-semibold">
                          <span>{ratioPercent1}%</span>
                          <span>{100 - ratioPercent1}%</span>
                        </div>
                        <div className="w-full bg-[#E7E0EC] h-1 rounded-full overflow-hidden">
                          <div className="bg-[#0B57D0] h-full" style={{ width: `${ratioPercent1}%` }}
                          ></div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-6 font-sans">
            {filteredAndSortedGroups
              .slice(0, exportLimit === -1 ? undefined : exportLimit)
              .map((group, index) => {
                const currentGroupStats = group;
                const totalMedia = Object.values(currentGroupStats.mediaCounts).reduce((acc, val) => acc + val, 0);

                const isDm = group.participants && group.participants.length === 2;
                let ratioLabel1 = '';
                let ratioPercent1 = 50;

                if (isDm) {
                  const myName = (globalStats && globalStats.myName) || 'Bạn';
                  const otherParticipant = group.participants.find(p => p !== myName);
                  const senderNames = Object.keys(group.senderCounts);
                  const mySenderName = senderNames.find(n => n === myName) || myName;
                  const friendName = senderNames.find(n => n !== mySenderName) || otherParticipant || 'Liên hệ';
                  const myCount = group.senderCounts[mySenderName] || 0;

                  ratioPercent1 = group.messageCount > 0 ? Math.round((myCount / group.messageCount) * 100) : 50;
                  ratioLabel1 = `${t.you}: ${ratioPercent1}% / ${t.recipient}: ${100 - ratioPercent1}%`;
                }

                const displayName = hideNames
                  ? (revealedNames.has(group.title)
                    ? group.title
                    : (lang === 'vi' ? `Liên hệ #${index + 1}` : `Contact #${index + 1}`))
                  : group.title;

                return (
                  <div
                    key={group.id}
                    className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] flex flex-col justify-between"
                  >
                    <div>
                      {/* Title + rank */}
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div className="flex items-center gap-3 min-w-0">
                          {hideAvatars && !revealedNames.has(group.title) ? (
                            <div className="w-11 h-11 rounded-full bg-[#E9EEF6] border border-[#CAC4D0] flex items-center justify-center text-[#49454F] shrink-0 font-bold">
                              <User className="w-5 h-5 text-[#625B71]" />
                            </div>
                          ) : (
                            renderAvatar(group.title, "w-11 h-11", "text-sm")
                          )}
                          <div className="min-w-0">
                            {avatarMap[group.title]?.url && (!hideNames || revealedNames.has(group.title)) ? (
                              <span className="font-extrabold text-[#0B57D0] truncate text-base block">
                                {displayName}
                              </span>
                            ) : (
                              <h4 className="font-extrabold text-[#1D1B20] truncate text-base">{displayName}</h4>
                            )}
                            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                              <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                                {getTranslatedChatType(group.type)}
                              </span>
                              {getE2EELabel(group) && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                                  E2EE
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-center w-9 h-9 rounded-full bg-white border border-[#CAC4D0] text-sm text-[#1D1B20] font-extrabold shrink-0 shadow-sm">
                          #{index + 1}
                        </div>
                      </div>

                      {/* Stats rows */}
                      <div className="space-y-3 my-5 text-sm text-[#49454F]">
                        <div className="flex justify-between">
                          <span>{t.sortMessages}:</span>
                          <span className="font-bold text-[#1D1B20] font-mono">{currentGroupStats.messageCount.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t.cardTotalReactions}:</span>
                          <span className="font-bold text-[#1D1B20] font-mono">{(currentGroupStats.reactionCount || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Media:</span>
                          <span className="font-bold text-[#1D1B20] font-mono">{totalMedia.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{lang === 'vi' ? 'Từ vựng:' : 'Words:'}</span>
                          <span className="font-bold text-[#1D1B20] font-mono">{currentGroupStats.totalWords.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between border-t border-[#CAC4D0] pt-2.5 mt-2.5">
                          <span>{t.firstMsgLabel}</span>
                          <span className="font-bold text-[#1D1B20] font-mono">{formatFirstMessageDate(group.dateRange?.start)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t.lastMsgLabel}</span>
                          <span className="font-bold text-[#0B57D0] font-mono">{formatLastMessageDaysAgo(group.dateRange?.end)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t.durationLabel}</span>
                          <span className="font-bold text-[#625B71] font-mono">{formatDuration(group.dateRange?.start, group.dateRange?.end)}</span>
                        </div>
                      </div>

                      {/* Split ratio bar */}
                      {isDm && ratioLabel1 && (
                        <div className="my-4">
                          <div className="flex justify-between text-[11px] text-[#49454F] mb-1.5 font-semibold">
                            <span>{t.chatRatio}</span>
                            <span>{ratioLabel1}</span>
                          </div>
                          <div className="w-full bg-[#E7E0EC] h-2 rounded-full overflow-hidden">
                            <div
                              className="bg-[#0B57D0] h-full"
                              style={{ width: `${ratioPercent1}%` }}
                            ></div>
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      className="w-full mt-4 py-3 rounded-full border border-[#79747E] bg-white text-[#0B57D0] text-xs font-bold flex items-center justify-center gap-1.5"
                    >
                      <span>{t.btnDetail}</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
          </div>
        )}

        {/* Footer Branding */}
        <div className="flex items-center justify-between border-t border-[#CAC4D0] pt-6 mt-4 text-xs text-[#625B71] font-semibold">
          <div className="flex items-center gap-2">
            <span>© {new Date().getFullYear()} {t.title}</span>
            <span>•</span>
            <span>{lang === 'vi' ? 'Phát triển bởi Phúc Đặng' : 'Developed by Phuc Dang'}</span>
          </div>
          <div>
            <span>GitHub Source Code: github.com/dangphuc2470/messenger-e2ee-count</span>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="relative min-h-screen grid-bg text-[#1D1B20] flex flex-col">

      {/* M3 Controls Top-Right Bar */}
      <div className="absolute top-4 right-4 flex items-center gap-4 z-20">
        {/* Language Switcher */}
        <div className="flex items-center gap-1 bg-[#E9EEF6] p-1 rounded-full border border-[#CAC4D0] shadow-sm">
          <button
            onClick={() => setLang('vi')}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer ${lang === 'vi' ? 'bg-[#0B57D0] text-white shadow' : 'text-[#49454F] hover:text-[#1D1B20]'
              }`}
          >
            Tiếng Việt
          </button>
          <button
            onClick={() => setLang('en')}
            className={`px-3 py-1 rounded-full text-xs font-bold transition-all cursor-pointer ${lang === 'en' ? 'bg-[#0B57D0] text-white shadow' : 'text-[#49454F] hover:text-[#1D1B20]'
              }`}
          >
            English
          </button>
        </div>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 pt-8 pb-0 sm:px-6 lg:px-8 flex flex-col flex-grow w-full">

        {/* ==================== SCREEN 1: LANDING ==================== */}
        {screen === 'landing' && (
          <div className="flex flex-col items-center justify-center text-center max-w-4xl mx-auto py-12 w-full">

            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#D3E3FD] text-[#041E49] text-sm font-semibold mb-8">
              <Shield className="w-4 h-4 text-[#0B57D0]" />
              <span>{t.badge}</span>
            </div>

            <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight mb-4 text-[#1D1B20]">
              {lang === 'vi' ? (
                <>Phân tích tin nhắn <span className="text-[#0B57D0]">Messenger</span></>
              ) : (
                <><span className="text-[#0B57D0]">Messenger</span> Insights & Counter</>
              )}
            </h1>

            <p className="text-lg text-[#49454F] max-w-2xl mb-12 leading-relaxed">
              {t.subtitle}
            </p>

            {/* Cached Data Detected Banner */}
            {hasCachedData && cachedMeta && (
              <div className="w-full max-w-xl mb-8 p-5 rounded-3xl bg-[#E9EEF6] border border-[#CAC4D0] text-left flex items-start gap-4 shadow-sm">
                <div className="p-3 rounded-full bg-[#D3E3FD] text-[#041E49] shrink-0 mt-1">
                  <Award className="w-6 h-6 text-[#0B57D0]" />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-[#1D1B20] text-base mb-1">
                    {lang === 'vi' ? 'Phát hiện kết quả phân tích đã lưu gần đây' : 'Recent analysis cache detected'}
                  </h4>
                  <p className="text-xs text-[#49454F] leading-relaxed mb-3">
                    {lang === 'vi'
                      ? `Đã lưu ngày: ${new Date(cachedMeta.timestamp).toLocaleString('vi-VN')} | Khoảng thời gian: ${formatDateRange(cachedMeta.dateRange)} | Tổng số tin: ${cachedMeta.totalMessages.toLocaleString()}`
                      : `Saved on: ${new Date(cachedMeta.timestamp).toLocaleString()} | Range: ${formatDateRange(cachedMeta.dateRange)} | Total: ${cachedMeta.totalMessages.toLocaleString()}`}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleLoadCache}
                      className="px-4.5 py-2 rounded-full bg-[#0B57D0] hover:bg-[#0842A0] text-white text-xs font-bold transition-all cursor-pointer shadow-sm"
                    >
                      {lang === 'vi' ? 'Tải lại kết quả này' : 'Load cached results'}
                    </button>
                    <button
                      onClick={handleClearCache}
                      className="px-4.5 py-2 rounded-full border border-[#79747E] bg-white hover:bg-[#F0F4F9] text-[#49454F] text-xs font-bold transition-all cursor-pointer"
                    >
                      {lang === 'vi' ? 'Xóa cache' : 'Clear cache'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Upload Options: Folder + ZIP */}
            <div className="w-full max-w-2xl mb-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Folder Select Card */}
                <label
                  htmlFor="folder-upload"
                  className="flex flex-col items-center justify-center px-6 py-10 rounded-[32px] bg-[#F0F4F9] border-2 border-[#CAC4D0] cursor-pointer group hover:bg-[#E9EEF6] hover:border-[#0B57D0] transition-all"
                >
                  <div className="p-3.5 rounded-full bg-[#D3E3FD] mb-4">
                    <FolderOpen className="w-7 h-7 text-[#0B57D0]" />
                  </div>
                  <span className="text-lg font-bold text-[#1D1B20] mb-1.5 text-center">{t.uploadTitle}</span>
                  <span className="text-xs text-[#49454F] text-center">{t.uploadSub}</span>
                  <input
                    type="file"
                    id="folder-upload"
                    webkitdirectory=""
                    directory=""
                    multiple
                    className="hidden"
                    onChange={handleFolderSelect}
                  />
                </label>

                {/* ZIP Select Card */}
                <label
                  htmlFor="zip-upload"
                  className="flex flex-col items-center justify-center px-6 py-10 rounded-[32px] bg-[#F0F4F9] border-2 border-[#CAC4D0] cursor-pointer group hover:bg-[#E9EEF6] hover:border-[#0B57D0] transition-all"
                >
                  <div className="p-3.5 rounded-full bg-[#D3E3FD] mb-4">
                    <FileArchive className="w-7 h-7 text-[#0B57D0]" />
                  </div>
                  <span className="text-lg font-bold text-[#1D1B20] mb-1.5 text-center">{t.uploadZipTitle}</span>
                  <span className="text-xs text-[#49454F] text-center">{t.uploadZipSub}</span>
                  <input
                    type="file"
                    id="zip-upload"
                    accept=".zip"
                    multiple
                    className="hidden"
                    onChange={handleZipSelect}
                  />
                </label>

              </div>

            </div>{/* end w-full max-w-2xl container */}

            {/* Avatar files for ZIP mode (optional) */}
            <div className="w-full max-w-2xl mb-8 -mt-4">
              <div className="flex flex-col gap-3 px-5 py-3.5 rounded-2xl bg-[#F0F4F9] border border-dashed border-[#CAC4D0] w-full text-left">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-full bg-[#D3E3FD] shrink-0">
                    <User className="w-4 h-4 text-[#0B57D0]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-[#1D1B20]">
                      {lang === 'vi' ? 'Ảnh đại diện (tùy chọn)' : 'Profile avatars (optional)'}
                    </p>
                    <p className="text-[10px] text-[#49454F] leading-normal">
                      {lang === 'vi'
                        ? 'Chọn file HTML bạn bè để tự động yêu cầu chọn thư mục ảnh tương ứng.'
                        : 'Select friends HTML file to auto-prompt for the companion image folder.'}
                    </p>
                    <p className="text-[10px] text-[#6750A4] font-medium leading-normal mt-0.5">
                      {lang === 'vi'
                        ? '💡 Mẹo: Nhấn Ctrl+S trên trang bạn bè Facebook để tải file HTML này và thư mục ảnh tương ứng về máy (hoặc nếu dùng chọn thư mục ở trên, bạn chỉ cần ném luôn tệp HTML và thư mục ảnh này vào chung thư mục là xong).'
                        : '💡 Tip: Press Ctrl+S on Facebook friends page to save it (HTML file + image folder). If using the folder selector above, simply place the HTML file and image folder inside that folder.'}
                    </p>
                  </div>
                </div>

                {/* Action Rows */}
                <div className="flex flex-wrap items-center gap-3 mt-1.5">
                  {/* HTML File Button */}
                  <button
                    type="button"
                    onClick={() => document.getElementById('zip-avatar-html-upload').click()}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      zipAvatarHtmlFile 
                        ? 'bg-[#E8F0FE] text-[#0B57D0] border border-[#ADCCF9]' 
                        : 'bg-white text-[#49454F] border border-[#CAC4D0] hover:bg-[#E9EEF6]'
                    }`}
                  >
                    {zipAvatarHtmlFile ? `📄 ${zipAvatarHtmlFile.name}` : (lang === 'vi' ? 'Chọn file HTML...' : 'Select HTML file...')}
                  </button>

                  {/* Folder / Images Button */}
                  <button
                    type="button"
                    disabled={!zipAvatarHtmlFile}
                    onClick={() => document.getElementById('zip-avatar-folder-upload').click()}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      zipAvatarImgCount > 0 
                        ? 'bg-[#E8F0FE] text-[#0B57D0] border border-[#ADCCF9]' 
                        : 'bg-white text-[#49454F] border border-[#CAC4D0] hover:bg-[#E9EEF6]'
                    }`}
                  >
                    {zipAvatarImgCount > 0 
                      ? `📁 ${zipAvatarFolderName} (${zipAvatarImgCount} ${lang === 'vi' ? 'ảnh' : 'images'})` 
                      : (lang === 'vi' 
                          ? (zipAvatarHtmlFile ? `Chọn thư mục ${zipAvatarFolderName}...` : 'Chọn thư mục ảnh...') 
                          : (zipAvatarHtmlFile ? `Select ${zipAvatarFolderName} folder...` : 'Select image folder...'))}
                  </button>

                  {/* Reset Button */}
                  {(zipAvatarHtmlFile || zipAvatarImgCount > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setZipAvatarHtmlFile(null);
                        setZipAvatarImgCount(0);
                        setZipAvatarFolderName('');
                        zipAvatarFilesRef.current = [];
                      }}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-red-500 transition-colors"
                      title={lang === 'vi' ? 'Xóa chọn' : 'Clear selection'}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Hidden inputs */}
                <input
                  type="file"
                  id="zip-avatar-html-upload"
                  accept=".html,.htm"
                  className="hidden"
                  onChange={handleHtmlFileChange}
                />
                <input
                  type="file"
                  id="zip-avatar-folder-upload"
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                  onChange={handleFolderChange}
                />
              </div>

            </div>{/* end w-full max-w-2xl container */}

            {/* Material 3 Features Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full text-left mt-8">
              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                <div className="flex items-center gap-3 mb-4 text-[#0B57D0]">
                  <Shield className="w-6 h-6" />
                  <h3 className="font-bold text-lg text-[#1D1B20]">{t.secureTitle}</h3>
                </div>
                <p className="text-sm text-[#49454F] leading-relaxed">
                  {t.secureDesc}
                </p>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                <div className="flex items-center gap-3 mb-4 text-[#0B57D0]">
                  <Users className="w-6 h-6" />
                  <h3 className="font-bold text-lg text-[#1D1B20]">{t.mergeTitle}</h3>
                </div>
                <p className="text-sm text-[#49454F] leading-relaxed">
                  {t.mergeDesc}
                </p>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                <div className="flex items-center gap-3 mb-4 text-[#0B57D0]">
                  <BarChart2 className="w-6 h-6" />
                  <h3 className="font-bold text-lg text-[#1D1B20]">{t.chartTitle}</h3>
                </div>
                <p className="text-sm text-[#49454F] leading-relaxed">
                  {t.chartDesc}
                </p>
              </div>
            </div>

          </div>
        )}

        {/* ==================== SCREEN 2: SCANNING ==================== */}
        {screen === 'scanning' && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <Loader2 className="w-12 h-12 text-[#0B57D0] animate-spin mb-8" />
            <h2 className="text-2xl font-bold text-[#1D1B20] mb-2">{t.scanningTitle}</h2>
            <p className="text-[#49454F] mb-6 text-sm">
              {t.scanningDesc}
            </p>

            <div className="w-full max-w-md bg-[#E7E0EC] rounded-full h-2 overflow-hidden mb-2">
              <div
                className="bg-[#0B57D0] h-full rounded-full transition-all duration-300"
                style={{ width: `${(scanProgress.current / scanProgress.total) * 100}%` }}
              ></div>
            </div>
            <div className="flex justify-between w-full max-w-md text-xs text-[#49454F] font-mono">
              <span>{scanProgress.current} / {scanProgress.total} {t.files}</span>
              <span>{Math.round((scanProgress.current / scanProgress.total) * 100)}%</span>
            </div>
          </div>
        )}

        {/* ==================== SCREEN 3: MERGE REVIEW ==================== */}
        {screen === 'merge_review' && (
          <div className="max-w-4xl mx-auto">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
              <div>
                <button
                  onClick={handleReset}
                  className="flex items-center gap-1.5 text-[#49454F] hover:text-[#1D1B20] transition-colors text-sm mb-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>{t.btnBack}</span>
                </button>
                <h2 className="text-3xl font-extrabold text-[#1D1B20]">{t.reviewTitle}</h2>
                <p className="text-sm text-[#49454F] mt-1">
                  {t.reviewSub(rawGroups.length)}
                </p>
              </div>

              <button
                onClick={handleStartAnalysis}
                className="px-6 py-3 rounded-full bg-[#0B57D0] text-white font-bold hover:bg-[#0842A0] transition-colors flex items-center justify-center gap-2 cursor-pointer shadow"
              >
                <span>{t.btnAnalyze}</span>
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-[#F0F4F9] rounded-[32px] overflow-hidden border border-[#CAC4D0]">

              {/* Checkbox All Bar */}
              <div className="flex items-center justify-between p-5 bg-[#D3E3FD] border-b border-[#CAC4D0] text-sm text-[#041E49]">
                <label className="flex items-center gap-3 cursor-pointer select-none font-semibold">
                  <input
                    type="checkbox"
                    className="w-5 h-5 rounded border-[#79747E] text-[#0B57D0] focus:ring-0 bg-white"
                    checked={selectedGroups.size === rawGroups.length}
                    onChange={(e) => toggleAllGroups(e.target.checked)}
                  />
                  <span>{t.selectAll(rawGroups.length)}</span>
                </label>
                <div className="font-mono text-xs font-semibold">
                  {t.estMessages(rawGroups.reduce((acc, g) => acc + g.totalMessages, 0))}
                </div>
              </div>

              {/* Quick Select Option Chips (Individuals / Groups / Both) */}
              <div className="flex flex-wrap gap-2 p-4 bg-[#E9EEF6] border-b border-[#CAC4D0] items-center">
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider pl-1 mr-1">{t.quickSelect}:</span>

                <button
                  onClick={selectAllTypes}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isAllSelected
                    ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                    : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                    }`}
                >
                  {t.selectAllBoth}
                </button>

                <button
                  onClick={() => selectOnlyType(CHAT_TYPES.INDIVIDUAL)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isOnlyIndividualSelected
                    ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                    : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                    }`}
                >
                  {t.selectOnlyIndividual}
                </button>

                <button
                  onClick={() => selectOnlyType(CHAT_TYPES.GROUP)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isOnlyGroupSelected
                    ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                    : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                    }`}
                >
                  {t.selectOnlyGroup}
                </button>

                {rawGroups.some(g => g.type === CHAT_TYPES.DATING) && (
                  <button
                    onClick={() => selectOnlyType(CHAT_TYPES.DATING)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isOnlyDatingSelected
                      ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                      : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                      }`}
                  >
                    {t.selectOnlyDating}
                  </button>
                )}

                {rawGroups.some(g => g.type === CHAT_TYPES.PAGE) && (
                  <button
                    onClick={() => selectOnlyType(CHAT_TYPES.PAGE)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isOnlyPageSelected
                      ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                      : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                      }`}
                  >
                    {t.selectOnlyPage}
                  </button>
                )}

                <button
                  onClick={selectNone}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer border ${isNoneSelected
                    ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                    : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                    }`}
                >
                  {t.deselectAll}
                </button>
              </div>

              {/* List */}
              <div className="divide-y divide-[#CAC4D0] max-h-[50vh] overflow-y-auto">
                {rawGroups.map(group => {
                  const merged = isE2EEMerged(group);
                  return (
                    <div
                      key={group.id}
                      className={`flex items-start gap-4 p-5 hover:bg-[#E9EEF6] transition-colors ${selectedGroups.has(group.id) ? 'bg-[#D3E3FD]/20' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="w-5 h-5 rounded border-[#79747E] text-[#0B57D0] focus:ring-0 bg-white mt-1 cursor-pointer"
                        checked={selectedGroups.has(group.id)}
                        onChange={() => toggleGroupSelection(group.id)}
                      />

                      {renderAvatar(group.title, "w-10 h-10", "text-xs")}

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {avatarMap[group.title]?.url ? (
                            <a
                              href={avatarMap[group.title].url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-bold text-[#0B57D0] hover:underline truncate max-w-xs sm:max-w-md block"
                            >
                              {group.title}
                            </a>
                          ) : (
                            <span className="font-bold text-[#1D1B20] truncate max-w-xs sm:max-w-md">{group.title}</span>
                          )}
                          <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                            {getTranslatedChatType(group.type)}
                          </span>

                          {getE2EELabel(group) && (
                            <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                              {getE2EELabel(group)}
                            </span>
                          )}
                        </div>

                        {/* List file paths inside group */}
                        <div className="mt-2 text-xs text-[#49454F] font-mono space-y-1">
                          {group.files.slice(0, 3).map((f, idx) => (
                            <div key={idx} className="truncate max-w-2xl flex justify-between">
                              <span className="truncate">{t.folder}: {f.filePath}</span>
                              <span className="text-[#625B71] pl-4">{f.messageCount.toLocaleString()} {t.messages} ({formatSize(f.fileSize)})</span>
                            </div>
                          ))}
                          {group.files.length > 3 && (
                            <div className="text-[10px] text-[#625B71] italic pl-4">
                              {lang === 'vi' ? `và ${group.files.length - 3} tệp tin khác...` : `and ${group.files.length - 3} other files...`}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-right min-w-[100px] pl-4">
                        <div className="text-base font-bold text-[#1D1B20] font-mono">{group.totalMessages.toLocaleString()}</div>
                        <div className="text-xs text-[#49454F]">{t.messages}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ==================== SCREEN 4: ANALYZING ==================== */}
        {screen === 'analyzing' && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <Loader2 className="w-12 h-12 text-[#0B57D0] animate-spin mb-8" />

            <h2 className="text-2xl font-bold text-[#1D1B20] mb-2">{t.analyzingTitle}</h2>
            <p className="text-[#49454F] mb-6 text-sm">
              {t.analyzingDesc}
            </p>

            <div className="w-full max-w-md bg-[#E7E0EC] rounded-full h-2 overflow-hidden mb-2">
              <div
                className="bg-[#0B57D0] h-full rounded-full transition-all duration-300"
                style={{ width: `${(analyzeProgress.currentFile / analyzeProgress.total) * 100}%` }}
              ></div>
            </div>
            <div className="flex justify-between w-full max-w-md text-xs text-[#49454F] font-mono">
              <span>{lang === 'vi' ? 'Hội thoại:' : 'Conversations:'} {analyzeProgress.currentFile} / {analyzeProgress.total}</span>
              <span>{Math.round((analyzeProgress.currentFile / analyzeProgress.total) * 100)}%</span>
            </div>

            <div className="mt-8 p-5 bg-[#F0F4F9] border border-[#CAC4D0] rounded-2xl w-full max-w-md text-left font-mono text-xs space-y-2">
              <div className="flex justify-between text-[#49454F]">
                <span>{t.totalProcessed}</span>
                <span className="text-[#1D1B20] font-bold">{analyzeProgress.processedMessages.toLocaleString()}</span>
              </div>
              <div className="border-t border-[#CAC4D0] pt-2 text-[#625B71] truncate">
                {t.file} {analyzeProgress.fileName}
              </div>
            </div>
          </div>
        )}

        {/* ==================== SCREEN 5: DASHBOARD ==================== */}
        {screen === 'dashboard' && globalStats && (
          <div className="w-full pb-12">

            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8 border-b border-[#CAC4D0] pb-6">
              <div>
                <h1 className="text-3xl font-extrabold text-[#1D1B20] flex items-center gap-3">
                  <BarChart2 className="w-8 h-8 text-[#0B57D0]" />
                  <span>
                    {lang === 'vi' ? (
                      <>Báo cáo thống kê <span className="text-[#0B57D0]">Messenger</span></>
                    ) : (
                      <><span className="text-[#0B57D0]">Messenger</span> Insights Report</>
                    )}
                  </span>
                </h1>
                <p className="text-sm text-[#49454F] mt-1">
                  {t.activeRange} <span className="text-[#0B57D0] font-bold">{formatDateRange(globalStats.dateRange)}</span>
                </p>
              </div>

              <div className="flex items-center gap-3 flex-wrap md:flex-nowrap">
                {/* Stats Mode Toggle (Personal vs General) */}
                <div className="flex items-center gap-1 bg-[#E9EEF6] p-1 rounded-full border border-[#CAC4D0] shadow-sm">
                  <button
                    onClick={() => setStatsMode('personal')}
                    className={`px-4 py-2 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${statsMode === 'personal' ? 'bg-[#0B57D0] text-white shadow-sm' : 'text-[#49454F] hover:text-[#1D1B20]'
                      }`}
                  >
                    <span>{lang === 'vi' ? 'Cá nhân' : 'Personal'}</span>
                  </button>
                  <button
                    onClick={() => setStatsMode('general')}
                    className={`px-4 py-2 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${statsMode === 'general' ? 'bg-[#0B57D0] text-white shadow-sm' : 'text-[#49454F] hover:text-[#1D1B20]'
                      }`}
                  >
                    <span>{lang === 'vi' ? 'Chung' : 'General'}</span>
                  </button>
                </div>

                {/* Reset & Cache Split Dropdown Button */}
                <div
                  ref={cacheMenuRef}
                  className="relative inline-flex items-center bg-[#D3E3FD] rounded-full border border-[#CAC4D0] overflow-visible shadow-sm"
                >
                  <button
                    onClick={handleReset}
                    className="pl-5 pr-3 py-3 rounded-l-full hover:bg-[#C2D9FC] text-[#041E49] font-bold transition-colors flex items-center gap-2 border-r border-[#CAC4D0] cursor-pointer"
                    title={t.btnReset}
                  >
                    <RefreshCw className="w-4 h-4 text-[#0B57D0]" />
                    <span>{t.btnReset}</span>
                  </button>
                  <button
                    onClick={() => setShowCacheMenu(!showCacheMenu)}
                    className="px-3 py-3 rounded-r-full hover:bg-[#C2D9FC] text-[#041E49] transition-colors flex items-center justify-center cursor-pointer"
                  >
                    <ChevronDown className="w-4 h-4 text-[#0B57D0]" />
                  </button>

                  {/* Cache Options Dropdown Menu */}
                  {showCacheMenu && (
                    <div className="absolute right-0 top-full mt-2 w-52 rounded-2xl bg-white border border-[#CAC4D0] shadow-lg py-2.5 z-30 font-sans text-xs">
                      <button
                        onClick={handleSaveCache}
                        disabled={isSavingCache}
                        className="w-full text-left px-4 py-2.5 hover:bg-[#F0F4F9] text-[#1D1B20] transition-colors flex items-center gap-2 font-bold cursor-pointer disabled:opacity-50"
                      >
                        <Award className="w-4 h-4 text-[#0B57D0]" />
                        <span>{t.cacheOptionSave}</span>
                      </button>
                      <button
                        onClick={handleClearCache}
                        className="w-full text-left px-4 py-2.5 hover:bg-[#F0F4F9] text-[#B3261E] hover:text-[#B3261E] transition-colors flex items-center gap-2 font-bold cursor-pointer"
                      >
                        <X className="w-4 h-4 text-[#B3261E]" />
                        <span>{t.cacheOptionClear}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Stat Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6 mb-8">

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
                <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                  <MessageSquare className="w-12 h-12" />
                </div>
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalMsg}</span>
                <div className="text-3xl font-black text-[#0B57D0] mt-2 font-mono">
                  {(statsMode === 'personal' ? globalStats.personal.totalMessages : globalStats.totalMessages).toLocaleString()}
                </div>
                <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Xử lý an toàn' : 'Processed securely'}</div>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
                <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                  <Sparkles className="w-12 h-12" />
                </div>
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalReactions}</span>
                <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                  {((statsMode === 'personal' ? globalStats.personal.totalReactions : globalStats.totalReactions) || 0).toLocaleString()}
                </div>
                <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Lượt bày tỏ cảm xúc' : 'Total reactions'}</div>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
                <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                  <Users className="w-12 h-12" />
                </div>
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalContacts}</span>
                <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                  {analyzedGroups.length.toLocaleString()}
                </div>
                <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Đã gộp các tệp E2EE' : 'E2EE folders merged'}</div>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
                <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                  <Image className="w-12 h-12" />
                </div>
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalMedia}</span>
                <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                  {(statsMode === 'personal' ? globalStats.personal.totalMedia : globalStats.totalMedia).toLocaleString()}
                </div>
                <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? 'Ảnh, video, thoại, tệp' : 'Photos, videos, audio, files'}</div>
              </div>

              <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] relative overflow-hidden">
                <div className="absolute top-4 right-4 text-[#0B57D0]/10">
                  <FileText className="w-12 h-12" />
                </div>
                <span className="text-xs text-[#49454F] font-bold uppercase tracking-wider">{t.cardTotalWords}</span>
                <div className="text-3xl font-black text-[#1D1B20] mt-2 font-mono">
                  {(statsMode === 'personal' ? globalStats.personal.totalWords : globalStats.totalWords).toLocaleString()}
                </div>
                <div className="text-xs text-[#625B71] mt-1">{lang === 'vi' ? `Ký tự: ${(statsMode === 'personal' ? globalStats.personal.totalCharacters : globalStats.totalCharacters).toLocaleString()}` : `Chars: ${(statsMode === 'personal' ? globalStats.personal.totalCharacters : globalStats.totalCharacters).toLocaleString()}`}</div>
              </div>

            </div>

            {/* M3 Segmented Button / Tabs */}
            <div className="flex gap-2 mb-8 bg-[#E9EEF6] p-1.5 rounded-full max-w-sm border border-[#CAC4D0]">
              <button
                onClick={() => setActiveTab('overview')}
                className={`flex-1 py-2.5 rounded-full text-sm font-bold transition-all cursor-pointer ${activeTab === 'overview'
                  ? 'bg-[#0B57D0] text-white shadow'
                  : 'text-[#49454F] hover:text-[#1D1B20] hover:bg-[#F0F4F9]'
                  }`}
              >
                {t.tabOverview}
              </button>
              <button
                onClick={() => setActiveTab('leaderboard')}
                className={`flex-1 py-2.5 rounded-full text-sm font-bold transition-all cursor-pointer ${activeTab === 'leaderboard'
                  ? 'bg-[#0B57D0] text-white shadow'
                  : 'text-[#49454F] hover:text-[#1D1B20] hover:bg-[#F0F4F9]'
                  }`}
              >
                {t.tabLeaderboard}
              </button>
            </div>

            {/* TAB CONTENT: OVERVIEW (CHARTS) */}
            {activeTab === 'overview' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Timeline Chart */}
                <div className="lg:col-span-2 p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                  <h3 className="text-lg font-bold text-[#1D1B20] mb-6 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-[#0B57D0]" />
                    <span>{t.chartTimeline}</span>
                  </h3>
                  <div className="h-[350px] relative">
                    <canvas ref={overallTimelineChartRef}></canvas>
                  </div>
                  <div className="text-[11px] text-[#625B71] mt-3 flex items-center gap-1 bg-[#E9EEF6] px-3.5 py-1.5 rounded-full border border-[#CAC4D0] w-fit">
                    <Info className="w-3.5 h-3.5 text-[#0B57D0]" />
                    <span>{lang === 'vi' ? 'Cuộn chuột kèm phím Ctrl để phóng to/thu nhỏ, nhấp và kéo chuột để di chuyển biểu đồ' : 'Hold Ctrl and scroll to zoom, click and drag to pan'}</span>
                  </div>
                </div>

                {/* Day of Week Chart */}
                <div className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                  <h3 className="text-lg font-bold text-[#1D1B20] mb-6 flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-[#625B71]" />
                    <span>{t.chartWeekly}</span>
                  </h3>
                  <div className="h-[350px] relative">
                    <canvas ref={dayOfWeekChartRef}></canvas>
                  </div>
                </div>

                {/* Hourly Chart */}
                <div className="lg:col-span-3 p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0]">
                  <h3 className="text-lg font-bold text-[#1D1B20] mb-6 flex items-center gap-2">
                    <Clock className="w-5 h-5 text-[#0B57D0]" />
                    <span>{t.chartHourly}</span>
                  </h3>
                  <div className="h-[250px] relative">
                    <canvas ref={hourlyActivityChartRef}></canvas>
                  </div>
                </div>

                {/* Media Breakdowns */}
                <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-5 gap-6">
                  {Object.entries(statsMode === 'personal' ? globalStats.personal.mediaCounts : globalStats.mediaCounts).map(([key, val]) => (
                    <div key={key} className="p-5 rounded-2xl bg-[#E9EEF6] border border-[#CAC4D0] text-center">
                      <span className="text-xs text-[#49454F] font-bold capitalize">{
                        key === 'photos' ? t.mediaPhotos :
                          key === 'videos' ? t.mediaVideos :
                            key === 'gifs' ? t.mediaGifs :
                              key === 'audio' ? t.mediaAudio :
                                key === 'stickers' ? t.mediaStickers : t.mediaFiles
                      }</span>
                      <div className="text-2xl font-black text-[#0B57D0] font-mono mt-2">{val.toLocaleString()}</div>
                    </div>
                  ))}
                </div>

              </div>
            )}

            {/* TAB CONTENT: LEADERBOARD / RANKINGS */}
            {activeTab === 'leaderboard' && (
              <div className="space-y-6">

                {/* Search & Sort & Filter Controls — single scrollable row */}
                <div className="flex items-center gap-3 bg-[#F0F4F9] px-4 py-3 rounded-[28px] border border-[#CAC4D0] overflow-x-auto">

                  {/* Search Box */}
                  <div className="relative shrink-0">
                    <Search className="w-3.5 h-3.5 text-[#49454F] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder={t.searchPlaceholder}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-white border border-[#79747E] rounded-full pl-9 pr-3 py-2 text-xs text-[#1D1B20] focus:outline-none focus:border-[#0B57D0] w-44"
                    />
                  </div>

                  <span className="text-[#CAC4D0] shrink-0">|</span>

                  {/* Chat Type Filter */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] text-[#49454F] uppercase tracking-wider font-bold whitespace-nowrap">{t.filterTypeLabel}:</span>
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      className="bg-white border border-[#79747E] text-[#1D1B20] rounded-full px-3 py-2 text-xs focus:outline-none focus:border-[#0B57D0] cursor-pointer"
                    >
                      <option value="all">{t.filterAll}</option>
                      <option value="individual">{t.individual}</option>
                      <option value="group">{t.group}</option>
                      {analyzedGroups.some(g => g.type === CHAT_TYPES.DATING) && (
                        <option value="dating">{t.dating}</option>
                      )}
                      {analyzedGroups.some(g => g.type === CHAT_TYPES.PAGE) && (
                        <option value="page">{t.page}</option>
                      )}
                    </select>
                  </div>

                  <span className="text-[#CAC4D0] shrink-0">|</span>

                  {/* Sort Selector */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] text-[#49454F] uppercase tracking-wider font-bold whitespace-nowrap">{t.sortByLabel}:</span>
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value)}
                      className="bg-white border border-[#79747E] text-[#1D1B20] rounded-full px-3 py-2 text-xs focus:outline-none focus:border-[#0B57D0] cursor-pointer"
                    >
                      <option value="messages">{t.sortMessages}</option>
                      <option value="reactions">{t.sortReactions}</option>
                      <option value="media">{t.sortMedia}</option>
                      <option value="words">{t.sortWords}</option>
                      <option value="characters">{t.sortChars}</option>
                    </select>
                  </div>

                  <span className="text-[#CAC4D0] shrink-0">|</span>

                  {/* Layout Mode Selector */}
                  <div className="flex items-center gap-0.5 bg-[#E9EEF6] p-0.5 rounded-full border border-[#CAC4D0] shrink-0">
                    <button
                      type="button"
                      onClick={() => setLayoutMode('grid')}
                      className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${layoutMode === 'grid' ? 'bg-[#0B57D0] text-white shadow' : 'text-[#49454F] hover:text-[#1D1B20]'}`}
                      title={lang === 'vi' ? 'Xem dạng lưới' : 'Grid view'}
                    >
                      <LayoutGrid className="w-3 h-3" />
                      <span>{lang === 'vi' ? 'Lưới' : 'Grid'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setLayoutMode('list')}
                      className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${layoutMode === 'list' ? 'bg-[#0B57D0] text-white shadow' : 'text-[#49454F] hover:text-[#1D1B20]'}`}
                      title={lang === 'vi' ? 'Xem dạng danh sách' : 'List view'}
                    >
                      <List className="w-3 h-3" />
                      <span>{lang === 'vi' ? 'Danh sách' : 'List'}</span>
                    </button>
                  </div>

                  {/* Spacer */}
                  <div className="flex-1" />

                  {/* Export Image Button */}
                  <button
                    onClick={handleOpenExportModal}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[#0B57D0] hover:bg-[#0842A0] text-white text-xs font-bold transition-all shadow cursor-pointer shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{t.btnExportImage}</span>
                  </button>

                </div>

                {/* Contacts Grid or List */}
                {layoutMode === 'list' ? (
                  <div className="flex flex-col gap-4">
                    {filteredAndSortedGroups
                      .slice(0, displayLimit === -1 ? undefined : displayLimit)
                      .map((group, index) => {
                        const currentGroupStats = group;
                        const totalMedia = Object.values(currentGroupStats.mediaCounts).reduce((acc, val) => acc + val, 0);

                        const isDm = group.participants && group.participants.length === 2;
                        let ratioLabel1 = '';
                        let ratioPercent1 = 50;

                        if (isDm) {
                          const myName = (globalStats && globalStats.myName) || 'Bạn';
                          const otherParticipant = group.participants.find(p => p !== myName);
                          const senderNames = Object.keys(group.senderCounts);
                          const mySenderName = senderNames.find(n => n === myName) || myName;
                          const friendName = senderNames.find(n => n !== mySenderName) || otherParticipant || 'Liên hệ';

                          const myCount = group.senderCounts[mySenderName] || 0;

                          ratioPercent1 = group.messageCount > 0 ? Math.round((myCount / group.messageCount) * 100) : 50;
                          ratioLabel1 = `${t.you}: ${ratioPercent1}% / ${t.recipient}: ${100 - ratioPercent1}%`;
                        }

                        const displayName = group.title;

                        return (
                          <div
                            key={group.id}
                            className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0] hover:bg-[#E9EEF6] transition-colors"
                          >
                            <div className="flex items-center gap-4 min-w-0 flex-1">
                              {/* Rank */}
                              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-white border border-[#CAC4D0] text-xs text-[#1D1B20] font-extrabold shrink-0 shadow-sm">
                                #{index + 1}
                              </div>
                              {/* Avatar */}
                              {renderAvatar(group.title, "w-10 h-10", "text-xs")}
                              {/* Name & Type */}
                              <div className="min-w-0">
                                {avatarMap[group.title]?.url ? (
                                  <a
                                    href={avatarMap[group.title].url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-extrabold text-[#0B57D0] hover:underline truncate text-sm block"
                                  >
                                    {displayName}
                                  </a>
                                ) : (
                                  <h4 className="font-extrabold text-[#1D1B20] truncate text-sm">{displayName}</h4>
                                )}
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                                    {getTranslatedChatType(group.type)}
                                  </span>
                                  {getE2EELabel(group) && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                                      E2EE
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Stats Summary columns */}
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-[#49454F] font-semibold md:min-w-[400px]">
                              <div>
                                <span className="block text-[9px] text-[#625B71] uppercase font-bold">{t.sortMessages}</span>
                                <span className="text-sm font-bold text-[#1D1B20] font-mono">{currentGroupStats.messageCount.toLocaleString()}</span>
                              </div>
                              <div>
                                <span className="block text-[9px] text-[#625B71] uppercase font-bold">{lang === 'vi' ? 'Cảm xúc' : 'Reactions'}</span>
                                <span className="text-sm font-bold text-[#1D1B20] font-mono">{(currentGroupStats.reactionCount || 0).toLocaleString()}</span>
                              </div>
                              <div>
                                <span className="block text-[9px] text-[#625B71] uppercase font-bold">Media</span>
                                <span className="text-sm font-bold text-[#1D1B20] font-mono">{totalMedia.toLocaleString()}</span>
                              </div>
                              <div>
                                <span className="block text-[9px] text-[#625B71] uppercase font-bold">{lang === 'vi' ? 'Từ vựng' : 'Words'}</span>
                                <span className="text-sm font-bold text-[#1D1B20] font-mono">{currentGroupStats.totalWords.toLocaleString()}</span>
                              </div>
                            </div>

                            {/* Details button / Ratio */}
                            <div className="flex items-center gap-3">
                              {isDm && ratioLabel1 && (
                                <div className="hidden lg:block w-24">
                                  <div className="flex justify-between text-[9px] text-[#49454F] mb-0.5 font-semibold">
                                    <span>{ratioPercent1}%</span>
                                    <span>{100 - ratioPercent1}%</span>
                                  </div>
                                  <div className="w-full bg-[#E7E0EC] h-1 rounded-full overflow-hidden">
                                    <div className="bg-[#0B57D0] h-full" style={{ width: `${ratioPercent1}%` }}></div>
                                  </div>
                                </div>
                              )}
                              <button
                                onClick={() => {
                                  setSelectedGroupDetails(group);
                                  setModalTab('stats');
                                  setVisibleMessageCount(150);
                                }}
                                className="p-2 rounded-full border border-[#79747E] bg-white hover:bg-[#F0F4F9] text-[#0B57D0] transition-colors"
                              >
                                <ChevronRight className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredAndSortedGroups
                      .slice(0, displayLimit === -1 ? undefined : displayLimit)
                      .map((group, index) => {
                        const currentGroupStats = group;
                        const totalMedia = Object.values(currentGroupStats.mediaCounts).reduce((acc, val) => acc + val, 0);

                        const isDm = group.participants && group.participants.length === 2;
                        let ratioLabel1 = '';
                        let ratioPercent1 = 50;

                        if (isDm) {
                          const myName = (globalStats && globalStats.myName) || 'Bạn';
                          const otherParticipant = group.participants.find(p => p !== myName);
                          const senderNames = Object.keys(group.senderCounts);
                          const mySenderName = senderNames.find(n => n === myName) || myName;
                          const friendName = senderNames.find(n => n !== mySenderName) || otherParticipant || 'Liên hệ';

                          const myCount = group.senderCounts[mySenderName] || 0;

                          ratioPercent1 = group.messageCount > 0 ? Math.round((myCount / group.messageCount) * 100) : 50;
                          ratioLabel1 = `${t.you}: ${ratioPercent1}% / ${t.recipient}: ${100 - ratioPercent1}%`;
                        }

                        return (
                          <div
                            key={group.id}
                            className="p-6 rounded-[28px] bg-[#F0F4F9] border border-[#CAC4D0] flex flex-col justify-between"
                          >
                            <div>
                              {/* Title + rank */}
                              <div className="flex items-start justify-between gap-3 mb-4">
                                <div className="flex items-center gap-3 min-w-0">
                                  {renderAvatar(group.title, "w-11 h-11", "text-sm")}
                                  <div className="min-w-0">
                                    {avatarMap[group.title]?.url ? (
                                      <a
                                        href={avatarMap[group.title].url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="font-extrabold text-[#0B57D0] hover:underline truncate text-base block"
                                      >
                                        {group.title}
                                      </a>
                                    ) : (
                                      <h4 className="font-extrabold text-[#1D1B20] truncate text-base">{group.title}</h4>
                                    )}
                                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                                      <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                                        {getTranslatedChatType(group.type)}
                                      </span>
                                      {getE2EELabel(group) && (
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                                          E2EE
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center justify-center w-9 h-9 rounded-full bg-white border border-[#CAC4D0] text-sm text-[#1D1B20] font-extrabold shrink-0 shadow-sm">
                                  #{index + 1}
                                </div>
                              </div>

                              {/* Stats rows */}
                              <div className="space-y-3 my-5 text-sm text-[#49454F]">
                                <div className="flex justify-between">
                                  <span>{t.sortMessages}:</span>
                                  <span className="font-bold text-[#1D1B20] font-mono">{currentGroupStats.messageCount.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>{t.cardTotalReactions}:</span>
                                  <span className="font-bold text-[#1D1B20] font-mono">{(currentGroupStats.reactionCount || 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Media:</span>
                                  <span className="font-bold text-[#1D1B20] font-mono">{totalMedia.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>{lang === 'vi' ? 'Từ vựng:' : 'Words:'}</span>
                                  <span className="font-bold text-[#1D1B20] font-mono">{currentGroupStats.totalWords.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between border-t border-[#CAC4D0] pt-2.5 mt-2.5">
                                  <span>{t.firstMsgLabel}</span>
                                  <span className="font-bold text-[#1D1B20] font-mono">{formatFirstMessageDate(group.dateRange?.start)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>{t.lastMsgLabel}</span>
                                  <span className="font-bold text-[#0B57D0] font-mono">{formatLastMessageDaysAgo(group.dateRange?.end)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>{t.durationLabel}</span>
                                  <span className="font-bold text-[#625B71] font-mono">{formatDuration(group.dateRange?.start, group.dateRange?.end)}</span>
                                </div>
                              </div>

                              {/* Split ratio bar */}
                              {isDm && ratioLabel1 && (
                                <div className="my-4">
                                  <div className="flex justify-between text-[11px] text-[#49454F] mb-1.5 font-semibold">
                                    <span>{t.chatRatio}</span>
                                    <span>{ratioLabel1}</span>
                                  </div>
                                  <div className="w-full bg-[#E7E0EC] h-2 rounded-full overflow-hidden">
                                    <div
                                      className="bg-[#0B57D0] h-full"
                                      style={{ width: `${ratioPercent1}%` }}
                                    ></div>
                                  </div>
                                </div>
                              )}
                            </div>

                            <button
                              onClick={() => {
                                setSelectedGroupDetails(group);
                                setModalTab('stats');
                                setVisibleMessageCount(150);
                              }}
                              className="w-full mt-4 py-3 rounded-full border border-[#79747E] bg-white hover:bg-[#F0F4F9] text-[#0B57D0] text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <span>{t.btnDetail}</span>
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        );
                      })}
                  </div>
                )}

                {/* Bottom Pagination & Limit Controls */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-8 bg-[#F0F4F9] p-5 rounded-[28px] border border-[#CAC4D0]">
                  {/* Left: Show more button (if there are more to show) */}
                  <div>
                    {displayLimit !== -1 && displayLimit < filteredAndSortedGroups.length ? (
                      <button
                        onClick={() => {
                          setDisplayLimit(prev => {
                            if (layoutMode === 'grid') {
                              if (prev === 9) return 21;
                              if (prev === 21) return 51;
                              if (prev === 51) return 99;
                              return -1;
                            } else {
                              if (prev === 10) return 20;
                              if (prev === 20) return 50;
                              if (prev === 50) return 100;
                              return -1;
                            }
                          });
                        }}
                        className="px-6 py-2.5 rounded-full bg-[#0B57D0] hover:bg-[#0842A0] text-white text-xs font-bold transition-all shadow cursor-pointer flex items-center gap-1.5"
                      >
                        <ChevronDown className="w-4 h-4" />
                        <span>{t.btnShowMore(filteredAndSortedGroups.length - displayLimit)}</span>
                      </button>
                    ) : (
                      <span className="text-xs text-[#625B71] font-semibold italic">
                        {lang === 'vi' ? 'Đã hiển thị tất cả liên hệ' : 'All contacts displayed'}
                      </span>
                    )}
                  </div>

                  {/* Right: Display Limit Selector */}
                  <div className="flex items-center gap-2.5">
                    <Award className="w-4 h-4 text-[#49454F] shrink-0" />
                    <span className="text-xs text-[#49454F] uppercase tracking-wider font-bold whitespace-nowrap">
                      {lang === 'vi' ? 'Giới hạn hiển thị:' : 'Display limit:'}
                    </span>
                    <select
                      value={displayLimit}
                      onChange={(e) => setDisplayLimit(Number(e.target.value))}
                      className="bg-white border border-[#79747E] text-[#1D1B20] rounded-full px-4 py-2 text-xs focus:outline-none focus:border-[#0B57D0] cursor-pointer font-bold shadow-sm"
                    >
                      {layoutMode === 'grid' ? (
                        <>
                          <option value={9}>Top 9</option>
                          <option value={21}>Top 21</option>
                          <option value={51}>Top 51</option>
                          <option value={99}>Top 99</option>
                          <option value={-1}>{lang === 'vi' ? 'Tất cả' : 'Show all'}</option>
                        </>
                      ) : (
                        <>
                          <option value={10}>Top 10</option>
                          <option value={20}>Top 20</option>
                          <option value={50}>Top 50</option>
                          <option value={100}>Top 100</option>
                          <option value={-1}>{lang === 'vi' ? 'Tất cả' : 'Show all'}</option>
                        </>
                      )}
                    </select>
                  </div>
                </div>

              </div>
            )}

          </div>
        )}

        {/* Footer */}
        <footer className="mt-auto py-6 border-t border-[#CAC4D0] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#625B71]">
          <div className="flex items-center gap-1.5 font-medium">
            <span>© {new Date().getFullYear()} {t.title}</span>
            <span>•</span>
            <span>{t.footerAuthor} <a href="https://github.com/dangphuc2470" target="_blank" rel="noopener noreferrer" className="font-bold text-[#0B57D0] hover:underline">Phúc Đặng</a></span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/dangphuc2470/messenger-e2ee-count"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 font-bold text-[#0B57D0] hover:underline"
            >
              <Shield className="w-3.5 h-3.5" />
              <span>{t.footerSource}</span>
            </a>
          </div>
        </footer>

      </div>

      {/* ==================== SCREEN 6: DETAILS MODAL ==================== */}
      {selectedGroupDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-4xl rounded-[32px] bg-[#F8FAFC] border border-[#CAC4D0] p-6 sm:p-8 overflow-hidden my-8 shadow-2xl">

            {/* Close */}
            <button
              onClick={() => setSelectedGroupDetails(null)}
              className="absolute top-5 right-5 p-2.5 rounded-full bg-[#E9EEF6] hover:bg-[#E6E1E5] text-[#49454F] hover:text-[#1D1B20] transition-colors cursor-pointer border border-[#CAC4D0]"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Modal Header */}
            <div className="flex items-center gap-4 mb-6 pr-12">
              {renderAvatar(selectedGroupDetails.title, "w-14 h-14", "text-xl")}
              <div className="min-w-0">
                {avatarMap[selectedGroupDetails.title]?.url ? (
                  <a
                    href={avatarMap[selectedGroupDetails.title].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-2xl font-black text-[#0B57D0] hover:underline truncate block"
                  >
                    {selectedGroupDetails.title}
                  </a>
                ) : (
                  <h2 className="text-2xl font-black text-[#1D1B20] truncate">{selectedGroupDetails.title}</h2>
                )}
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-[#D3E3FD] text-[#041E49] border border-[#CAC4D0]">
                    {getTranslatedChatType(selectedGroupDetails.type)}
                  </span>
                  {getE2EELabel(selectedGroupDetails) && (
                    <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-[#E9EEF6] text-[#0B57D0] border border-[#CAC4D0] font-bold">
                      {getE2EELabel(selectedGroupDetails)}
                    </span>
                  )}
                  <span className="text-xs text-[#49454F] font-mono">
                    {formatDateRange(selectedGroupDetails.dateRange)}
                  </span>
                </div>
              </div>
            </div>

            {/* Modal Navigation & Export Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 pt-2">
              {/* Modal Tabs / Segmented Buttons */}
              <div className="flex gap-2 bg-[#E9EEF6] p-1 rounded-full max-w-xs border border-[#CAC4D0] w-full sm:w-auto">
                <button
                  onClick={() => setModalTab('stats')}
                  className={`flex-1 sm:flex-initial px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${modalTab === 'stats'
                    ? 'bg-[#0B57D0] text-white shadow'
                    : 'text-[#49454F] hover:text-[#1D1B20]'
                    }`}
                >
                  {t.modalReportTab}
                </button>
                <button
                  onClick={() => setModalTab('chat')}
                  className={`flex-1 sm:flex-initial px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${modalTab === 'chat'
                    ? 'bg-[#0B57D0] text-white shadow'
                    : 'text-[#49454F] hover:text-[#1D1B20]'
                    }`}
                >
                  {t.modalChatTab}
                </button>
              </div>

              {/* Detail Export Actions */}
              <div className="flex items-center gap-2 flex-wrap">
                {modalTab === 'stats' && (
                  <button
                    onClick={handleExportDetailImage}
                    disabled={isExportingDetailImage}
                    className="py-2 px-4 rounded-full bg-[#E9EEF6] hover:bg-[#D3E3FD] text-[#0B57D0] border border-[#CAC4D0] text-xs font-bold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer disabled:opacity-50"
                  >
                    {isExportingDetailImage ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>{lang === 'vi' ? 'Đang tạo...' : 'Generating...'}</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>{lang === 'vi' ? 'Xuất ảnh thống kê' : 'Export Stats Image'}</span>
                      </>
                    )}
                  </button>
                )}

                {/* Dropdown for JSON Export */}
                <div ref={detailExportMenuRef} className="relative">
                  <button
                    onClick={() => setShowDetailExportMenu(!showDetailExportMenu)}
                    disabled={isExportingDetailJson}
                    className="py-2 px-4 rounded-full bg-[#0B57D0] hover:bg-[#0842A0] text-white text-xs font-bold flex items-center gap-1.5 transition-all shadow cursor-pointer disabled:opacity-50"
                  >
                    {isExportingDetailJson ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>{lang === 'vi' ? 'Đang xuất...' : 'Exporting...'}</span>
                      </>
                    ) : (
                      <>
                        <FileText className="w-3.5 h-3.5" />
                        <span>{lang === 'vi' ? 'Xuất tin nhắn JSON' : 'Export messages JSON'}</span>
                        <ChevronDown className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>

                  {showDetailExportMenu && (
                    <div className="absolute right-0 top-full mt-1.5 w-64 rounded-2xl bg-white border border-[#CAC4D0] shadow-lg py-2.5 z-50 font-sans text-xs">
                      <button
                        onClick={() => handleExportDetailJson('mine')}
                        className="w-full text-left px-4 py-2 hover:bg-[#F0F4F9] text-[#1D1B20] transition-colors flex flex-col font-bold cursor-pointer"
                      >
                        <span>{lang === 'vi' ? '1. Định dạng rút gọn (mine)' : '1. Clean Custom format'}</span>
                        <span className="text-[10px] text-[#625B71] font-normal mt-0.5">{lang === 'vi' ? 'Dạng danh sách tin nhắn phẳng tối giản' : 'Minimalist flat message list array'}</span>
                      </button>
                      <hr className="my-1.5 border-[#CAC4D0]/50" />
                      <button
                        onClick={() => handleExportDetailJson('fb_old')}
                        className="w-full text-left px-4 py-2 hover:bg-[#F0F4F9] text-[#1D1B20] transition-colors flex flex-col font-bold cursor-pointer"
                      >
                        <span>{lang === 'vi' ? '2. Facebook (Cấu trúc cũ - non-E2EE)' : '2. Facebook format (non-E2EE)'}</span>
                        <span className="text-[10px] text-[#625B71] font-normal mt-0.5">{lang === 'vi' ? 'Bao gồm sender_name, timestamp_ms,...' : 'Includes sender_name, timestamp_ms,...'}</span>
                      </button>
                      <hr className="my-1.5 border-[#CAC4D0]/50" />
                      <button
                        onClick={() => handleExportDetailJson('fb_e2ee')}
                        className="w-full text-left px-4 py-2 hover:bg-[#F0F4F9] text-[#1D1B20] transition-colors flex flex-col font-bold cursor-pointer"
                      >
                        <span>{lang === 'vi' ? '3. Facebook (Cấu trúc mới - E2EE)' : '3. Facebook format (E2EE)'}</span>
                        <span className="text-[10px] text-[#625B71] font-normal mt-0.5">{lang === 'vi' ? 'Bao gồm senderName, timestampMs,...' : 'Includes senderName, timestampMs,...'}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* TAB 1: ANALYTICS REPORT */}
            {modalTab === 'stats' && (
              <div ref={detailReportRef} className="p-4 bg-[#F8FAFC] rounded-3xl border border-[#CAC4D0]/40 overflow-y-auto max-h-[55vh] pr-2">
                {/* Stats Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
                  <div className="p-4 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0]">
                    <span className="text-xs text-[#49454F] block font-semibold">{t.cardTotalMsg}</span>
                    <span className="text-xl font-bold text-[#1D1B20] font-mono mt-1 block">{(statsMode === 'personal' ? selectedGroupDetails.personal.messageCount : selectedGroupDetails.messageCount).toLocaleString()}</span>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0]">
                    <span className="text-xs text-[#49454F] block font-semibold">{t.cardTotalReactions}</span>
                    <span className="text-xl font-bold text-[#0B57D0] font-mono mt-1 block">{(statsMode === 'personal' ? selectedGroupDetails.personal.reactionCount : selectedGroupDetails.reactionCount).toLocaleString()}</span>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0]">
                    <span className="text-xs text-[#49454F] block font-semibold">{t.avgChars}</span>
                    <span className="text-xl font-bold text-[#1D1B20] font-mono mt-1 block">
                      {(() => {
                        const target = statsMode === 'personal' ? selectedGroupDetails.personal : selectedGroupDetails;
                        return target.messageCount > 0
                          ? Math.round(target.totalCharacters / target.messageCount)
                          : 0;
                      })()}
                    </span>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0]">
                    <span className="text-xs text-[#49454F] block font-semibold">{t.mediaSent}</span>
                    <span className="text-xl font-bold text-[#1D1B20] font-mono mt-1 block">
                      {(() => {
                        const target = statsMode === 'personal' ? selectedGroupDetails.personal : selectedGroupDetails;
                        return Object.values(target.mediaCounts).reduce((acc, val) => acc + val, 0).toLocaleString();
                      })()}
                    </span>
                  </div>
                  <div className="p-4 rounded-2xl bg-[#F0F4F9] border border-[#CAC4D0]">
                    <span className="text-xs text-[#49454F] block font-semibold">{t.totalWords}</span>
                    <span className="text-xl font-bold text-[#625B71] font-mono mt-1 block">{(statsMode === 'personal' ? selectedGroupDetails.personal.totalWords : selectedGroupDetails.totalWords).toLocaleString()}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                  {/* Hourly Activity */}
                  <div className="p-5 rounded-2xl bg-white border border-[#CAC4D0]">
                    <h4 className="text-xs font-bold text-[#49454F] uppercase tracking-wider mb-4 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-[#0B57D0]" />
                      <span>{t.chartHourlyTitle}</span>
                    </h4>
                    <div className="h-[180px] relative">
                      <canvas ref={detailHourlyChartRef}></canvas>
                    </div>
                  </div>

                  {/* Monthly Timeline */}
                  <div className="p-5 rounded-2xl bg-white border border-[#CAC4D0]">
                    <h4 className="text-xs font-bold text-[#49454F] uppercase tracking-wider mb-4 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-[#625B71]" />
                      <span>{t.chartTimelineTitle}</span>
                    </h4>
                    <div className="h-[180px] relative">
                      <canvas ref={detailTimelineChartRef}></canvas>
                    </div>
                    <div className="text-[10px] text-[#625B71] mt-2.5 flex items-center gap-1 bg-[#E9EEF6] px-3 py-1 rounded-full border border-[#CAC4D0] w-fit">
                      <Info className="w-3 h-3 text-[#0B57D0]" />
                      <span>{lang === 'vi' ? 'Cuộn chuột kèm Ctrl để phóng to, nhấp kéo để di chuyển' : 'Hold Ctrl and scroll to zoom, drag to pan'}</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Sender Ratios */}
                  <div className="p-5 rounded-2xl bg-white border border-[#CAC4D0] flex flex-col justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-[#49454F] uppercase tracking-wider mb-4 flex items-center gap-1.5">
                        <Users className="w-4 h-4 text-[#0B57D0]" />
                        <span>{t.ratioTitle}</span>
                      </h4>
                      <div className="space-y-4 my-2 max-h-[140px] overflow-y-auto pr-1">
                        {Object.entries(selectedGroupDetails.senderCounts)
                          .sort((a, b) => b[1] - a[1])
                          .map(([name, count]) => {
                            const pct = selectedGroupDetails.messageCount > 0
                              ? Math.round((count / selectedGroupDetails.messageCount) * 100)
                              : 0;
                            return (
                              <div key={name} className="text-sm">
                                <div className="flex justify-between text-[#1D1B20] mb-1 font-semibold">
                                  <span className="truncate max-w-xs">{name === UNKNOWN_SENDER ? (lang === 'vi' ? 'Người tham gia' : 'Participant') : name}</span>
                                  <span className="font-mono text-xs">{count.toLocaleString()} tin ({pct}%)</span>
                                </div>
                                <div className="w-full bg-[#E7E0EC] h-2 rounded-full overflow-hidden">
                                  <div
                                    className="bg-[#0B57D0] h-full"
                                    style={{ width: `${pct}%` }}
                                  ></div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>

                    <div className="border-t border-[#E7E0EC] pt-4 mt-4 grid grid-cols-3 gap-2 text-center text-xs text-[#49454F] font-bold">
                      <div>{t.mediaPhotos}: {(statsMode === 'personal' ? selectedGroupDetails.personal.mediaCounts : selectedGroupDetails.mediaCounts).photos}</div>
                      <div>{t.mediaVideos}: {(statsMode === 'personal' ? selectedGroupDetails.personal.mediaCounts : selectedGroupDetails.mediaCounts).videos}</div>
                      <div>{lang === 'vi' ? 'Thoại' : 'Voice'}: {(statsMode === 'personal' ? selectedGroupDetails.personal.mediaCounts : selectedGroupDetails.mediaCounts).audio}</div>
                    </div>
                  </div>

                  {/* Word Frequencies */}
                  <div className="p-5 rounded-2xl bg-white border border-[#CAC4D0]">
                    <h4 className="text-xs font-bold text-[#49454F] uppercase tracking-wider mb-4 flex items-center gap-1.5">
                      <MessageCircle className="w-4 h-4 text-[#625B71]" />
                      <span>{t.topWordsTitle}</span>
                    </h4>

                    {(() => {
                      const targetFreq = statsMode === 'personal' ? selectedGroupDetails.personal.wordFrequencies : selectedGroupDetails.wordFrequencies;
                      return Object.keys(targetFreq).length === 0 ? (
                        <p className="text-xs text-[#49454F] italic text-center py-8">{t.noTextData}</p>
                      ) : (
                        <div className="flex flex-wrap gap-2 max-h-[160px] overflow-y-auto pr-1">
                          {Object.entries(targetFreq)
                            .slice(0, 20)
                            .map(([word, freq]) => (
                              <div
                                key={word}
                                className="px-3 py-1 rounded-full bg-[#E9EEF6] border border-[#CAC4D0] text-[#1D1B20] hover:border-[#0B57D0] transition-colors text-xs flex items-center gap-2"
                              >
                                <span className="font-bold">{word}</span>
                                <span className="text-[10px] text-[#49454F] font-mono bg-white px-1.5 py-0.5 rounded-full border border-[#CAC4D0]">{freq}</span>
                              </div>
                            ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: INTERACTIVE CHAT CONVERSATION VIEW */}
            {modalTab === 'chat' && (
              <div className="flex flex-col bg-[#F0F4F9] rounded-3xl border border-[#CAC4D0] overflow-hidden">

                {/* Chat header/stats */}
                <div className="px-5 py-3.5 bg-[#D3E3FD] border-b border-[#CAC4D0] flex flex-col sm:flex-row justify-between sm:items-center gap-3 text-sm text-[#041E49] font-bold">
                  <span>
                    {t.chatHeader}{' '}
                    {avatarMap[selectedGroupDetails.title]?.url ? (
                      <a
                        href={avatarMap[selectedGroupDetails.title].url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#0B57D0] hover:underline"
                      >
                        {selectedGroupDetails.title}
                      </a>
                    ) : (
                      selectedGroupDetails.title
                    )}
                  </span>
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-[#49454F] font-semibold">{lang === 'vi' ? 'Thứ tự:' : 'Order:'}</span>
                      <select
                        value={chatSortOrder}
                        onChange={(e) => {
                          setChatSortOrder(e.target.value);
                          setVisibleMessageCount(150); // Reset pagination count on change
                        }}
                        className="bg-white border border-[#79747E] text-[#1D1B20] rounded-full px-3 py-1 text-xs focus:outline-none focus:border-[#0B57D0] cursor-pointer font-semibold shadow-sm"
                      >
                        <option value="oldest">{lang === 'vi' ? 'Cũ nhất trước' : 'Oldest first'}</option>
                        <option value="newest">{lang === 'vi' ? 'Mới nhất trước' : 'Newest first'}</option>
                      </select>
                    </div>
                    <span>{t.cardTotalMsg}: {selectedGroupDetails.messageCount.toLocaleString()} | {t.cardTotalReactions}: {(selectedGroupDetails.reactionCount || 0).toLocaleString()}</span>
                  </div>
                </div>

                {/* Message Log Viewport */}
                <div
                  ref={chatContainerRef}
                  className="p-5 h-[400px] overflow-y-auto flex flex-col gap-4 bg-white"
                >
                  {/* Load more button */}
                  {/* Load more button (At top for Oldest First) */}
                  {chatSortOrder === 'oldest' && selectedGroupDetails.messagesList.length > visibleMessageCount && (
                    <button
                      onClick={() => setVisibleMessageCount(prev => prev + 250)}
                      className="self-center px-4 py-2 text-xs font-bold text-[#0B57D0] bg-[#D3E3FD] hover:bg-[#C2D9FC] rounded-full transition-colors flex items-center gap-1.5 cursor-pointer shadow border border-[#CAC4D0] mb-2"
                    >
                      <ChevronDown className="w-3.5 h-3.5 rotate-180" />
                      <span>{t.btnOlderMsgs(selectedGroupDetails.messagesList.length - visibleMessageCount)}</span>
                    </button>
                  )}

                  {selectedGroupDetails.messagesList.length === 0 ? (
                    <div className="text-center py-12 text-sm text-[#49454F] italic">{t.noMessages}</div>
                  ) : (
                    (() => {
                      const sortedMessages = [...selectedGroupDetails.messagesList];
                      if (chatSortOrder === 'newest') {
                        sortedMessages.reverse();
                      }
                      const slicedMessages = chatSortOrder === 'newest'
                        ? sortedMessages.slice(0, visibleMessageCount)
                        : sortedMessages.slice(-visibleMessageCount);

                      return slicedMessages.map((msg, index) => {
                        if (msg.isReaction) {
                          return (
                            <div
                              key={index}
                              className="self-center my-1 text-[11px] text-[#625B71] bg-[#E9EEF6] px-3.5 py-1.5 rounded-full border border-[#CAC4D0] italic text-center max-w-[90%] font-semibold"
                            >
                              {msg.content} <span className="text-[9px] not-italic ml-1.5 text-[#49454F] font-mono">({formatMsgTime(msg.timestamp)})</span>
                            </div>
                          );
                        }

                        const isMe = isCurrentUser(msg.sender);

                        return (
                          <div
                            key={index}
                            className={`flex flex-col max-w-[75%] ${isMe ? 'self-end items-end' : 'self-start items-start'}`}
                          >
                            {/* Sender name for groups */}
                            {!isMe && selectedGroupDetails.type === CHAT_TYPES.GROUP && (
                              <span className="text-[10px] text-[#49454F] font-bold mb-1 pl-2">
                                {msg.sender === UNKNOWN_SENDER ? (lang === 'vi' ? 'Người tham gia' : 'Participant') : msg.sender}
                              </span>
                            )}

                            {/* Bubble */}
                            <div className={`p-3.5 ${isMe ? 'chat-bubble-user' : 'chat-bubble-friend'} text-sm shadow-sm leading-relaxed break-words w-full`}>
                              {msg.content}
                              {msg.isMedia && (
                                <div className="text-xs mt-1.5 px-2.5 py-1 rounded bg-black/10 border border-black/5 font-semibold text-center italic">
                                  {t.mediaAttached} {
                                    msg.mediaType === MEDIA_TYPES.PHOTO ? t.mediaPhotos :
                                      msg.mediaType === MEDIA_TYPES.VIDEO ? t.mediaVideos :
                                        msg.mediaType === MEDIA_TYPES.GIF ? t.mediaGifs :
                                          msg.mediaType === MEDIA_TYPES.AUDIO ? t.mediaAudio :
                                            msg.mediaType === MEDIA_TYPES.STICKER ? t.mediaStickers : t.mediaFiles
                                  }
                                </div>
                              )}
                            </div>

                            {/* Timestamp */}
                            <span className="text-[9px] text-[#625B71] mt-1 pr-1 pl-1">
                              {formatMsgTime(msg.timestamp)}
                            </span>
                          </div>
                        );
                      });
                    })()
                  )}

                  {/* Load more button (At bottom for Newest First) */}
                  {chatSortOrder === 'newest' && selectedGroupDetails.messagesList.length > visibleMessageCount && (
                    <button
                      onClick={() => setVisibleMessageCount(prev => prev + 250)}
                      className="self-center px-4 py-2 text-xs font-bold text-[#0B57D0] bg-[#D3E3FD] hover:bg-[#C2D9FC] rounded-full transition-colors flex items-center gap-1.5 cursor-pointer shadow border border-[#CAC4D0] mt-2"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                      <span>{t.btnOlderMsgs(selectedGroupDetails.messagesList.length - visibleMessageCount)}</span>
                    </button>
                  )}
                </div>

              </div>
            )}

          </div>
        </div>
      )}

      {/* ==================== SCREEN 7: EXPORT IMAGE MODAL ==================== */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-5xl rounded-[32px] bg-[#F8FAFC] border border-[#CAC4D0] p-6 sm:p-8 overflow-y-auto max-h-[90vh] shadow-2xl my-8">
            {/* Close */}
            <button
              onClick={() => setShowExportModal(false)}
              className="absolute top-5 right-5 p-2.5 rounded-full bg-[#E9EEF6] hover:bg-[#E6E1E5] text-[#49454F] hover:text-[#1D1B20] transition-colors cursor-pointer border border-[#CAC4D0]"
            >
              <X className="w-5 h-5" />
            </button>

            <h3 className="text-xl font-bold text-[#1D1B20] mb-6 flex items-center gap-2 pr-8">
              <Image className="w-6 h-6 text-[#0B57D0]" />
              <span>{t.exportModalTitle}</span>
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
              {/* Left Column: Options (span 2) */}
              <div className="lg:col-span-2 space-y-5">
                <div>
                  <label className="block text-sm font-bold text-[#49454F] mb-3">
                    {t.exportSelectTop}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(layoutMode === 'grid' ? [3, 9, 21, 51, 99, -1] : [3, 10, 20, 50, 100, -1]).map((opt) => (
                      <button
                        key={opt}
                        onClick={() => { setExportLimit(opt); setCustomExportLimit(''); }}
                        className={`py-2 px-3 text-xs font-bold rounded-full border transition-all cursor-pointer text-center ${exportLimit === opt && customExportLimit === ''
                          ? 'bg-[#0B57D0] text-white border-[#0B57D0] shadow-sm'
                          : 'bg-white text-[#49454F] border-[#CAC4D0] hover:bg-[#F0F4F9]'
                          }`}
                      >
                        {opt === -1 ? t.exportAllOption : t.exportTopOption(opt)}
                      </button>
                    ))}
                  </div>
                  {/* Custom export number input */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-[#49454F] font-bold whitespace-nowrap shrink-0">{lang === 'vi' ? 'Số tùy chỉnh:' : 'Custom:'}</span>
                    <input
                      type="number"
                      min={1}
                      max={filteredAndSortedGroups.length}
                      placeholder={lang === 'vi' ? 'Nhập số...' : 'Enter number...'}
                      value={customExportLimit}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomExportLimit(val);
                        const n = parseInt(val, 10);
                        if (!isNaN(n) && n > 0) setExportLimit(n);
                      }}
                      className={`w-full bg-white border rounded-full px-3 py-1.5 text-xs focus:outline-none cursor-pointer font-bold shadow-sm ${
                        customExportLimit !== '' ? 'border-[#0B57D0] ring-1 ring-[#0B57D0]' : 'border-[#79747E] focus:border-[#0B57D0]'
                      }`}
                    />
                  </div>
                </div>

                <div className="bg-[#E9EEF6] border border-[#CAC4D0] rounded-2xl p-4 text-xs text-[#49454F] flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-[#0B57D0] shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold mb-1">
                      {lang === 'vi' ? 'Thông tin xuất ảnh:' : 'Image Export Info:'}
                    </p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>{t.exportFilterLabel}: <span className="font-bold text-[#1D1B20]">{filterType === 'all' ? t.filterAll : getTranslatedChatType(filterType)}</span></li>
                      <li>{t.exportSortLabel}: <span className="font-bold text-[#1D1B20]">{sortBy === 'messages' ? t.sortMessages : sortBy === 'reactions' ? t.sortReactions : sortBy === 'media' ? t.sortMedia : sortBy === 'words' ? t.sortWords : t.sortChars}</span></li>
                      <li>{lang === 'vi' ? 'Số lượng xuất:' : 'Export limit:'} <span className="font-bold text-[#1D1B20]">{exportLimit === -1 ? `${filteredAndSortedGroups.length} (Tất cả)` : `${Math.min(exportLimit, filteredAndSortedGroups.length)} / ${filteredAndSortedGroups.length}`}</span></li>
                    </ul>
                  </div>
                </div>

                {/* Display Options Checkboxes */}
                <div className="space-y-4 bg-[#F0F4F9] border border-[#CAC4D0] rounded-2xl p-4">
                  <span className="block text-xs font-bold text-[#49454F] uppercase tracking-wider mb-2">
                    {lang === 'vi' ? 'Tùy chọn hiển thị' : 'Display Options'}
                  </span>

                  <label className="flex items-center gap-2.5 text-xs text-[#1D1B20] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hideOverview}
                      onChange={(e) => setHideOverview(e.target.checked)}
                      className="w-4 h-4 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer"
                    />
                    <span>{lang === 'vi' ? 'Ẩn phần Tổng quan (Overview)' : 'Hide Overview summary'}</span>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-[#1D1B20] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hideNames}
                      onChange={(e) => {
                        setHideNames(e.target.checked);
                        if (!e.target.checked && !hideAvatars) {
                          setRevealedNames(new Set());
                        }
                      }}
                      className="w-4 h-4 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer"
                    />
                    <span>{lang === 'vi' ? 'Ẩn tên liên hệ (Ẩn danh)' : 'Hide contact names (Anonymous)'}</span>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-[#1D1B20] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hideAvatars}
                      onChange={(e) => setHideAvatars(e.target.checked)}
                      className="w-4 h-4 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer"
                    />
                    <span>{lang === 'vi' ? 'Ẩn ảnh đại diện' : 'Hide profile pictures'}</span>
                  </label>

                  {/* Tick list dropdown for revealing specific people if anonymous all is selected OR avatars are hidden */}
                  {(hideNames || hideAvatars) && (
                    <div className="space-y-2 relative pt-2 border-t border-[#CAC4D0]" ref={revealDropdownRef}>
                      <label className="block text-[11px] font-bold text-[#625B71] uppercase tracking-wider pl-1">
                        {lang === 'vi' ? 'Giữ lại tên thật & ảnh của liên hệ cụ thể:' : 'Keep real name & avatar for specific contacts:'}
                      </label>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowRevealDropdown(!showRevealDropdown)}
                          className="w-full bg-white border border-[#CAC4D0] text-[#1D1B20] rounded-xl px-3.5 py-2 text-xs font-bold text-left flex items-center justify-between cursor-pointer focus:outline-none focus:border-[#0B57D0] shadow-sm"
                        >
                          <span className="truncate pr-2">
                            {revealedNames.size === 0
                              ? (lang === 'vi' ? 'Không có liên hệ được hiện' : 'No contacts revealed')
                              : (lang === 'vi' ? `Đã chọn hiện (${revealedNames.size})` : `Revealed (${revealedNames.size})`)}
                          </span>
                          <ChevronDown className={`w-4 h-4 text-[#49454F] shrink-0 transition-transform ${showRevealDropdown ? 'rotate-180' : ''}`} />
                        </button>

                        {showRevealDropdown && (
                          <div className="absolute left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-white border border-[#CAC4D0] rounded-xl shadow-lg p-2.5 z-40 space-y-1.5">
                            {filteredAndSortedGroups
                              .slice(0, exportLimit === -1 ? undefined : exportLimit)
                              .map((g, idx) => {
                                const isChecked = revealedNames.has(g.title);
                                return (
                                  <label
                                    key={g.id}
                                    className="flex items-center gap-2 text-xs text-[#1D1B20] font-semibold cursor-pointer hover:bg-[#F0F4F9] px-2 py-1.5 rounded-lg transition-colors"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => {
                                        const next = new Set(revealedNames);
                                        if (isChecked) {
                                          next.delete(g.title);
                                        } else {
                                          next.add(g.title);
                                        }
                                        setRevealedNames(next);
                                      }}
                                      className="w-3.5 h-3.5 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer shrink-0"
                                    />
                                    <span className="truncate">{g.title} (#{(idx + 1)})</span>
                                  </label>
                                );
                              })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* JSON Options Checkboxes */}
                <div className="space-y-4 bg-[#F0F4F9] border border-[#CAC4D0] rounded-2xl p-4">
                  <span className="block text-xs font-bold text-[#49454F] uppercase tracking-wider mb-2">
                    {lang === 'vi' ? 'Tùy chọn xuất JSON' : 'JSON Export Options'}
                  </span>

                  <label className="flex items-center gap-2.5 text-xs text-[#1D1B20] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={jsonIncludeOverview}
                      onChange={(e) => setJsonIncludeOverview(e.target.checked)}
                      className="w-4 h-4 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer"
                    />
                    <span>{lang === 'vi' ? 'Bao gồm Tổng quan (Overview)' : 'Include Overview summary'}</span>
                  </label>

                  <label className="flex items-center gap-2.5 text-xs text-[#1D1B20] font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={jsonIncludeTimeline}
                      onChange={(e) => setJsonIncludeTimeline(e.target.checked)}
                      className="w-4 h-4 rounded text-[#0B57D0] focus:ring-[#0B57D0] cursor-pointer"
                    />
                    <span>{lang === 'vi' ? 'Bao gồm Timeline của từng người' : 'Include monthly/hourly timeline for each contact'}</span>
                  </label>
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col gap-3 pt-2">
                  <div className="flex gap-3">
                    <button
                      onClick={handleExportImage}
                      disabled={isExporting || filteredAndSortedGroups.length === 0}
                      className="flex-1 py-3 rounded-full bg-[#0B57D0] hover:bg-[#0842A0] text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 shadow"
                    >
                      {isExporting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>{t.exportGenerating}</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          <span>{t.exportBtnDownload}</span>
                        </>
                      )}
                    </button>
                    <button
                      onClick={handleExportJson}
                      disabled={isExporting || filteredAndSortedGroups.length === 0}
                      className="flex-1 py-3 rounded-full bg-[#E9EEF6] hover:bg-[#D3E3FD] text-[#0B57D0] border border-[#CAC4D0] text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-sm"
                    >
                      <FileText className="w-4 h-4" />
                      <span>{t.exportBtnDownloadJson}</span>
                    </button>
                  </div>
                  <button
                    onClick={() => setShowExportModal(false)}
                    className="w-full py-3 rounded-full border border-[#79747E] bg-white hover:bg-[#F0F4F9] text-[#49454F] text-xs font-bold transition-all cursor-pointer"
                  >
                    {lang === 'vi' ? 'Đóng' : 'Close'}
                  </button>
                </div>
              </div>

              {/* Right Column: Preview (span 3) */}
              <div ref={previewParentRef} className="lg:col-span-3 flex flex-col gap-3">
                <span className="block text-xs font-bold text-[#49454F] uppercase tracking-wider">
                  {lang === 'vi' ? 'Bản xem trước hình ảnh (WYSIWYG Live Preview):' : 'Image Live Preview (WYSIWYG):'}
                </span>

                <div className="overflow-y-auto max-h-[550px] overflow-x-hidden border border-[#CAC4D0] rounded-2xl bg-[#E7E0EC] shadow-inner p-4 flex justify-center items-start">
                  <div
                    style={{
                      height: `${templateHeight * previewScale}px`,
                      width: `${1200 * previewScale}px`,
                      position: 'relative',
                      overflow: 'hidden',
                      transition: 'height 0.2s ease-out'
                    }}
                    className="rounded-xl border border-[#CAC4D0] shadow-md bg-[#F8FAFC]"
                  >
                    <div
                      ref={exportPreviewRef}
                      className="bg-[#F8FAFC] grid-bg p-8 flex flex-col gap-6 text-[#1D1B20] text-left"
                      style={{
                        fontFamily: "system-ui, -apple-system, sans-serif",
                        width: '1200px',
                        boxSizing: 'border-box',
                        transform: `scale(${previewScale})`,
                        transformOrigin: 'top left',
                        position: 'absolute',
                        left: 0,
                        top: 0
                      }}
                    >
                      {renderExportTemplateContent()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== OFF-SCREEN EXPORT TEMPLATE ==================== */}
      {globalStats && (
        <div style={{ position: 'absolute', left: '-9999px', top: '-9999px', width: '1200px', overflow: 'hidden' }}>
          <div
            ref={exportAreaRef}
            className="bg-[#F8FAFC] grid-bg p-8 flex flex-col gap-6 text-[#1D1B20]"
            style={{ fontFamily: "system-ui, -apple-system, sans-serif", width: '1200px', boxSizing: 'border-box' }}
          >
            {renderExportTemplateContent()}
          </div>
        </div>
      )}

      {/* Details modal closing */}

    </div>
  );
}

export default App;
