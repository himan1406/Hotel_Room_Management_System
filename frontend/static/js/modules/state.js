// ==================== Shared State Variables ====================
// Declared here so all modules can reference them (this file loads first)

// Messaging state
let ws = null;
let wsReconnectTimer = null;
let msgCurrentOtherId = null;
let msgCurrentPropertyId = null;
let msgCurrentOtherRole = null;
let msgLastMessageId = null;

// Review state
let selectedRating = 0;
let selectedEditRating = 0;

// Dashboard state
let currentSelectedProperty = null;
let selectedCompareIds = [];
let compareChatHistory = [];
let comparisonContext = null;

// Search state
let lastSearchResults = [];

// Booking cart state
let bookingCart = {};  // keyed by `${propertyId}:${roomId}`: { propId, roomData, qty, pricePerUnit }
