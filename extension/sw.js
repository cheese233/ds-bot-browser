// Nothing listens for clicks: the host drives tabCapture over CDP
// (tabCapture.getMediaStreamId + offscreen.createDocument) after triggerAction
// satisfies Chrome's "extension was invoked on this tab" gate.
chrome.runtime.onInstalled.addListener(() => {})
