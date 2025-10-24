const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['ðŸ’‹', 'ðŸ¬', 'ðŸ«†', 'ðŸ’—', 'ðŸŽˆ', 'ðŸŽ‰', 'ðŸ¥³', 'â¤ï¸', 'ðŸ§«', 'ðŸ­'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/CDPTTUY9PahGCIAkmmPXc2?mode=wwc',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/84288h.jpg',
    NEWSLETTER_JID: '120363395674230271@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94761427943',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb6Hil8CcW4mKCBklN1P'
};

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = 'Janith sathsara117';
const repo = 'session';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

case 'ping': {
    const startTime = Date.now();
    await socket.sendPresenceUpdate('composing', sender);

    // Calculate ping
    const latency = Date.now() - startTime;

    // Calculate uptime
    const startTimeBot = socketCreationTime.get(number) || Date.now();
    const uptimeSec = Math.floor((Date.now() - startTimeBot) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = Math.floor(uptimeSec % 60);

    // Time & Date (Sri Lanka)
    const date = new Date().toLocaleDateString('en-LK', { timeZone: 'Asia/Colombo' });
    const time = new Date().toLocaleTimeString('en-LK', { timeZone: 'Asia/Colombo' });

    const caption = `
ðŸ“ *PONG!*
âš¡ *Response:* ${latency} ms
ðŸ•’ *Uptime:* ${hours}h ${minutes}m ${seconds}s
ðŸ“… *Date:* ${date}
â° *Time:* ${time}

> *POWERED BY JANI-MD*
`;

    await socket.sendMessage(sender, {
        text: caption
    }, { quoted: msg });
    break;
	}
  case 'alive': {
  const startTime = socketCreationTime.get(number) || Date.now();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  const now = new Date();
  const date = now.toLocaleDateString('en-LK', { timeZone: 'Asia/Colombo' });
  const time = now.toLocaleTimeString('en-LK', { timeZone: 'Asia/Colombo' });

  const pingStart = Date.now();
  await socket.sendPresenceUpdate('composing', sender);
  const ping = Date.now() - pingStart;

  const captionText = `
â•­â”€â”€â”€â”€â”€â”€â *JANI-MD STATUS PANEL* ââ”€â”€â”€â”€â”€â”€â•®
â”‚ðŸ“… *Date:* ${date}
â”‚â° *Time:* ${time}
â”‚âš¡ *Uptime:* ${hours}h ${minutes}m ${seconds}s
â”‚ðŸ“¶ *Ping:* ${ping}ms
â”‚ðŸ‘¤ *User:* ${number}
â”‚ðŸ’  *Owner:* JANI-MD TEAM
â”‚ðŸ§© *Version:* 1.0.0
â”‚âœ… *Status:* Bot is Alive & Working Fine!
â•°â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•¯
> *POWERED BY JANI-MD*
`;

  await socket.sendMessage(sender, {
      image: { url: "https://files.catbox.moe/84288h.jpg" },
      caption: captionText,
      footer: 'JANI-MD BOT SYSTEM'
  }, { quoted: msg });

  break; // <- à¶¸à·™à¶º à¶…à·€à·ƒà·à¶±à·’à¶±à·Š à¶­à·’à¶ºà·™à¶±à·Šà¶± à¶•à¶±à·™
	  }
    case 'menu': {
    // Menu command
    const menuImage = "https://files.catbox.moe/84288h.jpg";
    const menuText = `
â•­â”€â”€â”€â”€â”€â”€â *JANI-MD MINI BOT MENU* ââ”€â”€â”€â”€â”€â”€â•®
â”‚ðŸ’  *.alive* - Check bot status
â”‚ðŸ’  *.song* - Download YouTube songs
â”‚ðŸ’  *.video* - Download YouTube videos
â”‚ðŸ’  *.tiktok* - Download TikTok video
â”‚ðŸ’  *.fb* - Facebook video downloader
â”‚ðŸ’  *.ig* - Instagram downloader
â”‚ðŸ’  *.aiimg* - AI Image Generator
â”‚ðŸ’  *.logo* - Create logo styles
â”‚ðŸ’  *.fancy* - Fancy text generator
â”‚ðŸ’  *.ts* - Search TikTok videos
â”‚ðŸ’  *.ai* - Chat with JANI AI
â”‚ðŸ’  *.news* - Lanka news
â”‚ðŸ’  *.gossip* - Gossip Lanka
â”‚ðŸ’  *.nasa* - NASA space updates
â”‚ðŸ’  *.cricket* - Cricket news
â”‚ðŸ’  *.bomb* - Send multiple messages
â”‚ðŸ’  *.deleteme* - Delete session
â”‚
â•°â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â•¯
> *POWERED BY JANI-MD TEAM*
`;

    await socket.sendMessage(sender,{
        image: { url: menuImage },
        caption: menuText,
        footer: 'JANI-MD FREE BOT SYSTEM'
    }, { quoted: msg });
		}		

    break;
}
					
					
                case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: 'â— Please provide a channel JID.\n\nExample:\n.fcn 120363396379901844@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: 'â— Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `âœ… Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `ðŸ“Œ Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('âŒ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `âŒ Error: ${e.message}`
                        });
                    }
                    break;
                }
                case 'pair': {
    // âœ… Fix for node-fetch v3.x (ESM-only module)
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

    if (!number) {
        return await socket.sendMessage(sender, {
            text: '*ðŸ“Œ Usage:* .pair +9470604XXXX'
        }, { quoted: msg });
    }

    try {
        const url = `http://206.189.94.231:8000/code?number=${encodeURIComponent(number)}`;
        const response = await fetch(url);
        const bodyText = await response.text();

        console.log("ðŸŒ API Response:", bodyText);

        let result;
        try {
            result = JSON.parse(bodyText);
        } catch (e) {
            console.error("âŒ JSON Parse Error:", e);
            return await socket.sendMessage(sender, {
                text: 'âŒ Invalid response from server. Please contact support.'
            }, { quoted: msg });
        }

        if (!result || !result.code) {
            return await socket.sendMessage(sender, {
                text: 'âŒ Failed to retrieve pairing code. Please check the number.'
            }, { quoted: msg });
        }

        await socket.sendMessage(sender, {
            text: `> *JANI-ðŒð™³ ðŒð™¸ð™½ð™¸ ðð™¾ðšƒ ðð™°ð™¸ðš ð‚ð™¾ð™¼ð™¿ð™»ð™´ðšƒð™´ð™³* âœ…\n\n*ðŸ”‘ Your pairing code is:* ${result.code}`
        }, { quoted: msg });

        await sleep(2000);

        await socket.sendMessage(sender, {
            text: `${result.code}`
        }, { quoted: msg });

    } catch (err) {
        console.error("âŒ Pair Command Error:", err);
        await socket.sendMessage(sender, {
            text: 'âŒ An error occurred while processing your request. Please try again later.'
        }, { quoted: msg });
    }

    break;
}
case 'viewonce':
case 'rvo':
case 'vv': {
await socket.sendMessage(sender, { react: { text: 'âœ¨', key: msg.key } });
try{
if (!msg.quoted) return reply("ðŸš© *Please reply to a viewonce message*");
let quotedmsg = msg?.msg?.contextInfo?.quotedMessage
await oneViewmeg(socket, isOwner, quotedmsg , sender)
}catch(e){
console.log(e)
m.reply(`${e}`)
}
    break;
}

             case 'logo': { 
              const q = args.join(" ");

if (!q || q.trim() === '') {
    return await socket.sendMessage(sender, { text: '*`Need a name for logo`*' });
}

await socket.sendMessage(sender, { react: { text: 'â¬†ï¸', key: msg.key } });
const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

const rows = list.data.map((v) => ({
    title: v.name,
    description: 'Tap to generate logo',
    id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
}));

const buttonMessage = {
    buttons: [
        {
            buttonId: 'action',
            buttonText: { displayText: 'ðŸŽ¨ Select Text Effect' },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'Available Text Effects',
                    sections: [
                        {
                            title: 'Choose your logo style',
                            rows
                        }
                    ]
                })
            }
        }
    ],
    headerType: 1,
    viewOnce: true,
    caption: 'â *LOGO MAKER*',
    image: { url: 'https://files.catbox.moe/sn20tl.jpg' },
};

await socket.sendMessage(from, buttonMessage, { quoted: msg });
break;

}

case 'dllogo': { const q = args.join(" "); if (!q) return reply("Please give me url for capture the screenshot !!");

try {
    const res = await axios.get(q);
    const images = res.data.result.download_url;

    await socket.sendMessage(m.chat, {
        image: { url: images },
        caption: config.CAPTION
    }, { quoted: msg });
} catch (e) {
    console.log('Logo Download Error:', e);
    await socket.sendMessage(from, {
        text: `âŒ Error:\n${e.message}`
    }, { quoted: msg });
}
break;

}
              case 'aiimg': {
  const axios = require('axios');

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const prompt = q.trim();

  if (!prompt) {
    return await socket.sendMessage(sender, {
      text: 'ðŸŽ¨ *Please provide a prompt to generate an AI image.*'
    });
  }

  try {
    // Notify that image is being generated
    await socket.sendMessage(sender, {
      text: 'ðŸ§  *Creating your AI image...*',
    });

    // Build API URL
    const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;

    // Call the AI API
    const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

    // Validate API response
    if (!response || !response.data) {
      return await socket.sendMessage(sender, {
        text: 'âŒ *API did not return a valid image. Please try again later.*'
      });
    }

    // Convert the binary image to buffer
    const imageBuffer = Buffer.from(response.data, 'binary');

    // Send the image
    await socket.sendMessage(sender, {
      image: imageBuffer,
      caption: `ðŸ§  *JANI-MD AI IMAGE*\n\nðŸ“Œ Prompt: ${prompt}`
    }, { quoted: msg });

  } catch (err) {
    console.error('AI Image Error:', err);

    await socket.sendMessage(sender, {
      text: `â— *An error occurred:* ${err.response?.data?.message || err.message || 'Unknown error'}`
    });
  }

  break;
}
              case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "âŽ *Please provide text to convert into fancy fonts.*\n\nðŸ“Œ *Example:* `.fancy JANI`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "âŒ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `ðŸŽ¨ *Fancy Fonts Converter*\n\n${fontList}\n\n_ðð™¾ðš†ð™´ðšð™³ ððšˆ JANI ðŒð™³_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "âš ï¸ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
       }
	      case 'ts': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const query = q.replace(/^[.\/!]ts\s*/i, '').trim();

    if (!query) {
        return await socket.sendMessage(sender, {
            text: '[â—] TikTok à¶‘à¶šà·š à¶¸à·œà¶šà¶¯à·Šà¶¯ à¶¶à¶½à¶±à·Šà¶± à¶•à¶±à·™ à¶šà·’à¶ºà¶´à¶‚! ðŸ”'
        }, { quoted: msg });
    }

    async function tiktokSearch(query) {
        try {
            const searchParams = new URLSearchParams({
                keywords: query,
                count: '10',
                cursor: '0',
                HD: '1'
            });

            const response = await axios.post("https://api.id.dexter.it.com/search/tiktok/tsdown?url", searchParams, {
                headers: {
                    'Content-Type': "application/x-www-form-urlencoded; charset=UTF-8",
                    'Cookie': "current_language=en",
                    'User-Agent': "Mozilla/5.0"
                }
            });

            const videos = response.data?.data?.videos;
            if (!videos || videos.length === 0) {
                return { status: false, result: "No videos found." };
            }

            return {
                status: true,
                result: videos.map(video => ({
                    description: video.title || "No description",
                 videoUrl: video.play || ""
                }))
            };
        } catch (err) {
            return { status: false, result: err.message };
        }
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    try {
        const searchResults = await tiktokSearch(query);
        if (!searchResults.status) throw new Error(searchResults.result);

        const results = searchResults.result;
        shuffleArray(results);

        const selected = results.slice(0, 6);

        const cards = await Promise.all(selected.map(async (vid) => {
            const videoBuffer = await axios.get(vid.videoUrl, { responseType: "arraybuffer" });

            const media = await prepareWAMessageMedia({ video: videoBuffer.data }, {
                upload: socket.waUploadToServer
            });

            return {
                body: proto.Message.InteractiveMessage.Body.fromObject({ text: '' }),
                footer: proto.Message.InteractiveMessage.Footer.fromObject({ text: "JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ" }),
                header: proto.Message.InteractiveMessage.Header.fromObject({
                    title: vid.description,
                    hasMediaAttachment: true,
                    videoMessage: media.videoMessage // ðŸŽ¥ Real video preview
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                    buttons: [] // âŒ No buttons
                })
            };
        }));

        const msgContent = generateWAMessageFromContent(sender, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                        body: { text: `ðŸ”Ž *TikTok Search:* ${query}` },
                        footer: { text: "> ðð™¾ðš†ð™´ðšð™³ ððšˆ JANI-ðŒð™³" },
                        header: { hasMediaAttachment: false },
                        carouselMessage: { cards }
                    })
                }
            }
        }, { quoted: msg });

        await socket.relayMessage(sender, msgContent.message, { messageId: msgContent.key.id });

    } catch (err) {
        await socket.sendMessage(sender, {
            text: `âŒ Error: ${err.message}`
        }, { quoted: msg });
    }

    break;
}
              case 'bomb': {
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text || '';
    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

    const count = parseInt(countRaw) || 5;

    if (!target || !text || !count) {
        return await socket.sendMessage(sender, {
            text: 'ðŸ“Œ *Usage:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 9470XXXXXXX,Hello ðŸ‘‹,5'
        }, { quoted: msg });
    }

    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    if (count > 20) {
        return await socket.sendMessage(sender, {
            text: 'âŒ *Limit is 20 messages per bomb.*'
        }, { quoted: msg });
    }

    for (let i = 0; i < count; i++) {
        await socket.sendMessage(jid, { text });
        await delay(700); // small delay to prevent block
    }

    await socket.sendMessage(sender, {
        text: `âœ… Bomb sent to ${target} â€” ${count}x`
    }, { quoted: msg });

    break;
}          
                case 'tiktok': {
    const axios = require('axios');

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    const link = q.replace(/^[.\/!]tiktok(dl)?|tt(dl)?\s*/i, '').trim();

    if (!link) {
        return await socket.sendMessage(sender, {
            text: 'ðŸ“Œ *Usage:* .tiktok <link>'
        }, { quoted: msg });
    }

    if (!link.includes('tiktok.com')) {
        return await socket.sendMessage(sender, {
            text: 'âŒ *Invalid TikTok link.*'
        }, { quoted: msg });
    }

    try {
        await socket.sendMessage(sender, {
            text: 'â³ Downloading video, please wait...'
        }, { quoted: msg });

        const apiUrl = `https://api.id.dexter.it.com/download/tiktok?url=${encodeURIComponent(link)}`;
        const { data } = await axios.get(apiUrl);

        if (!data?.status || !data?.data) {
            return await socket.sendMessage(sender, {
                text: 'âŒ Failed to fetch TikTok video.'
            }, { quoted: msg });
        }

        const { title, like, comment, share, author, meta } = data.data;
        const video = meta.media.find(v => v.type === "video");

        if (!video || !video.org) {
            return await socket.sendMessage(sender, {
                text: 'âŒ No downloadable video found.'
            }, { quoted: msg });
        }

        const caption = `ðŸŽµ *TikTok Video*\n\n` +
                        `ðŸ‘¤ *User:* ${author.nickname} (@${author.username})\n` +
                        `ðŸ“– *Title:* ${title}\n` +
                        `ðŸ‘ *Likes:* ${like}\nðŸ’¬ *Comments:* ${comment}\nðŸ” *Shares:* ${share}`;

        await socket.sendMessage(sender, {
            video: { url: video.org },
            caption: caption,
            contextInfo: { mentionedJid: [msg.key.participant || sender] }
        }, { quoted: msg });

    } catch (err) {
        console.error("TikTok command error:", err);
        await socket.sendMessage(sender, {
            text: `âŒ An error occurred:\n${err.message}`
        }, { quoted: msg });
    }

    break;
}

                case 'fb': {
    const axios = require('axios');
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || 
              '';

    const fbUrl = q?.trim();

    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
        return await socket.sendMessage(sender, { text: 'ðŸ§© *Please provide a valid Facebook video link.*' });
    }

    try {
        const res = await axios.get(`https://zylalabs.com/api/3881/facebook+media+downloader+api/4582/download+reel+or+video/fbdown?url=${encodeURIComponent(fbUrl)}`);
        const result = res.data.result;

        await socket.sendMessage(sender, { react: { text: 'â¬‡', key: msg.key } });

        await socket.sendMessage(sender, {
            video: { url: result.sd },
            mimetype: 'video/mp4',
            caption: '> ðð™¾ðš†ð™´ðšð™³ ððšˆ JANI-ðŒð™³'
        }, { quoted: msg });

        await socket.sendMessage(sender, { react: { text: 'âœ”', key: msg.key } });

    } catch (e) {
        console.log(e);
        await socket.sendMessage(sender, { text: '*âŒ Error downloading video.*' });
    }

    break;
}
					case 'ig': {
  const axios = require('axios');

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  const igUrl = q?.trim();

  if (!/instagram\.com/.test(igUrl)) {
    return await socket.sendMessage(sender, {
      text: 'ðŸ“Œ *Please provide a valid Instagram link.*\n\nExample:\n`.ig https://www.instagram.com/reel/.../`',
    });
  }

  try {
    await socket.sendMessage(sender, { text: 'â³ *Downloading Instagram video... Please wait.*' });

    // ðŸ§  API URL à¶‘à¶š à¶¸à·™à¶­à¶± à¶¯à·à¶±à·Šà¶± (Replace this with your working API)
    const apiUrl = `https://api.id.dexter.it.com/download/instagram?url=${encodeURIComponent(igUrl)}`;
    // ðŸ‘‰ Example alternative free API (if the above one stops working)
    // const apiUrl = `https://api.falsisdevs.site/downloader/ig?url=${encodeURIComponent(igUrl)}`;

    const { data } = await axios.get(apiUrl);

    // âœ… Validate API response
    if (!data || !data.data || !data.data[0]?.url) {
      return await socket.sendMessage(sender, {
        text: 'âŒ *Failed to fetch Instagram video. Please try again later.*',
      });
    }

    const videoUrl = data.data[0].url;
    const thumbnail = data.data[0].thumbnail || 'https://files.catbox.moe/84288h.jpg';
    const title = data.data[0].title || 'Instagram Reel';

    // ðŸ–¼ï¸ Send preview image
    await socket.sendMessage(sender, {
      image: { url: thumbnail },
      caption: `ðŸŽ¬ *${title}*\nðŸ“Ž *Source:* ${igUrl}\n> *POWERED BY JANI-MD*`,
    }, { quoted: msg });

    // ðŸŽ¥ Send downloaded video
    await socket.sendMessage(sender, {
      video: { url: videoUrl },
      mimetype: 'video/mp4',
      caption: 'âœ… *Instagram video downloaded successfully!*\n> *POWERED BY JANI-MD*',
    }, { quoted: msg });

  } catch (e) {
    console.error('Instagram API Error:', e.message);
    await socket.sendMessage(sender, {
      text: `âŒ *Error fetching from API:* ${e.message}`,
    });
  }

  break;
					
					}							
                case 'gossip':
    // Gossip news
    try {
        
        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
        if (!response.ok) {
            throw new Error('API à¶‘à¶šà·™à¶±à·Š news à¶œà¶±à·Šà¶± à¶¶à·à¶»à·’ à·€à·”à¶«à·.à¶¶à¶±à·Š ðŸ˜©');
        }
        const data = await response.json();


        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
            throw new Error('API à¶‘à¶šà·™à¶±à·Š à¶½à·à¶¶à·”à¶«à·” news data à·€à¶½ à¶œà·à¶§à¶½à·”à·€à¶šà·Š');
        }


        const { title, desc, date, link } = data.result;


        let thumbnailUrl = 'https://via.placeholder.com/150';
        try {
            
            const pageResponse = await fetch(link);
            if (pageResponse.ok) {
                const pageHtml = await pageResponse.text();
                const $ = cheerio.load(pageHtml);
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) {
                    thumbnailUrl = ogImage; 
                } else {
                    console.warn(`No og:image found for ${link}`);
                }
            } else {
                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
            }
        } catch (err) {
            console.warn(`Thumbnail scrape à¶šà¶»à¶±à·Šà¶± à¶¶à·à¶»à·’ à·€à·”à¶«à· from ${link}: ${err.message}`);
        }


        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                'ðŸ“° JANI-MD GOSSIP à¶±à·€à¶­à¶¸ à¶´à·”à·€à¶­à·Š ðŸ“°',
                `ðŸ“¢ *${title}*\n\n${desc}\n\nðŸ•’ *Date*: ${date || 'à¶­à·€à¶¸ à¶½à¶¶à·à¶¯à·“à¶½à· à¶±à·à¶­'}\nðŸŒ *Link*: ${link}`,
                'JANI ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
            )
        });
    } catch (error) {
        console.error(`Error in 'news' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: 'âš ï¸ à¶±à·’à·€à·Šà·ƒà·Š à¶œà¶±à·Šà¶± à¶¶à·à¶»à·’ à·€à·”à¶«à· à·ƒà·”à¶¯à·Šà¶¯à·! ðŸ˜© à¶ºà¶¸à¶šà·Š à·€à·à¶»à¶¯à·”à¶«à· à·€à¶œà·š.'
        });
    }
               case 'nasa':
    try {
      
        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
        if (!response.ok) {
            throw new Error('Failed to fetch APOD from NASA API');
        }
        const data = await response.json();

     
        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
            throw new Error('Invalid APOD data received or media type is not an image');
        }

        const { title, explanation, date, url, copyright } = data;
        const thumbnailUrl = url || 'https://via.placeholder.com/150'; // Use APOD image URL or fallback

     
        await socket.sendMessage(sender, {
            image: { url: thumbnailUrl },
            caption: formatMessage(
                'ðŸŒŒ JANI-ðŒðƒ ðð€ð’ð€ ðð„ð–ð’',
                `ðŸŒ  *${title}*\n\n${explanation.substring(0, 200)}...\n\nðŸ“† *Date*: ${date}\n${copyright ? `ðŸ“ *Credit*: ${copyright}` : ''}\nðŸ”— *Link*: https://apod.nasa.gov/apod/astropix.html`,
                '> JANI-ðŒð™³ ðŒð™¸ð™½ð™¸ ðð™¾ðšƒ'
            )
        });

    } catch (error) {
        console.error(`Error in 'apod' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: 'âš ï¸ à¶•à·€à· à¶¶à¶½à¶±à·Šà¶± à¶•à¶±à·’ à¶±à· à¶œà·’à·„à·’à¶±à·Š à¶±à·’à¶¯à·à¶œà¶±à·Šà¶±'
        });
    }
    break;
                case 'news':
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                'ðŸ“° JANI-MD à¶±à·€à¶­à¶¸ à¶´à·”à·€à¶­à·Š ðŸ“°',
                                `ðŸ“¢ *${title}*\n\n${desc}\n\nðŸ•’ *Date*: ${date}\nðŸŒ *Link*: ${link}`,
                                'JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: 'âš ï¸ à·„à· à·„à· NEWS à¶¶à¶½à¶±à·Šà¶± à¶•à¶±à·š à¶±à·‘ à¶œà·’à·„à·’à¶±à·Š à¶´à¶­à·Šà¶­à¶»à¶ºà¶šà·Š à¶šà·’à¶ºà·€à¶œà¶±à·Šà¶±'
                        });
                    }
                    break;
                case 'cricket':
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                'ðŸ JANI-MD CRICKET NEWSðŸ',
                                `ðŸ“¢ *${title}*\n\n` +
                                `ðŸ† *Mark*: ${score}\n` +
                                `ðŸŽ¯ *To Win*: ${to_win}\n` +
                                `ðŸ“ˆ *Current Rate*: ${crr}\n\n` +
                                `ðŸŒ *Link*: ${link}`,
                                'JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: 'âš ï¸ à·„à· à·„à· Cricket à¶•à¶±à·š à¶±à·‘ à¶œà·’à·„à·’à¶±à·Š à·€à·™à¶± à¶¸à·œà¶šà¶šà·Š à·„à¶»à·’ à¶¶à¶½à¶±à·Šà¶±.'
                        });
                    }
                    break;
		}
		case 'song': {
  const yts = require('yt-search');
  const axios = require('axios');

  const q = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption || '';

  const songName = q.replace(/^[./!]song\s*/i, '').trim();

  if (!songName) {
    return await socket.sendMessage(sender, { text: 'ðŸŽµ *Please enter a song name!*' });
  }

  await socket.sendMessage(sender, { text: 'ðŸŽ§ *Searching for your song...* ðŸŽ¶' }, { quoted: msg });

  try {
    const search = await yts(songName);
    const video = search.videos[0];
    if (!video) {
      return await socket.sendMessage(sender, { text: 'âŒ *No results found on YouTube.*' });
    }

    // âœ… Stable API for mp3 download
    const apiUrl = `https://api.falsisdevs.site/downloader/ytmp3?url=${encodeURIComponent(video.url)}`;
    const { data } = await axios.get(apiUrl);

    if (!data?.status || !data?.result?.download_url) {
      return await socket.sendMessage(sender, { text: 'âŒ *Failed to get download link. Try again later.*' });
    }

    const caption = `
ðŸŽ¶ *Title:* ${video.title}
ðŸ•’ *Duration:* ${video.timestamp}
ðŸ‘€ *Views:* ${video.views}
ðŸ“… *Uploaded:* ${video.ago}
> *POWERED BY JANI-MD*
`;

    await socket.sendMessage(sender, {
      image: { url: video.thumbnail },
      caption
    }, { quoted: msg });

    await socket.sendMessage(sender, {
      audio: { url: data.result.download_url },
      mimetype: 'audio/mpeg',
      ptt: false
    }, { quoted: msg });

  } catch (err) {
    console.error('Song Command Error:', err);
    await socket.sendMessage(sender, { text: 'âš ï¸ *Error fetching song. Please try again later.*' });
  }
  break;
		}
		           case 'video': {
  const yts = require('yt-search');
  const axios = require('axios');

  const q = msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption || '';

  const searchQuery = q.replace(/^[./!]video\s*/i, '').trim();

  if (!searchQuery) {
    return await socket.sendMessage(sender, { text: 'ðŸ“Œ *Usage:* .video <YouTube Link or Name>' }, { quoted: msg });
  }

  await socket.sendMessage(sender, { text: 'ðŸŽ¥ *Downloading video... Please wait.*' }, { quoted: msg });

  try {
    let videoUrl = searchQuery;

    // ðŸ” If it's not a full YouTube link, search it first
    if (!/youtu\.be|youtube\.com/.test(videoUrl)) {
      const search = await yts(searchQuery);
      if (!search.videos || search.videos.length === 0) {
    return await socket.sendMessage(sender, { 
        text: 'âŒ *No video found on YouTube.*' 
    }, { quoted: msg });
	  }
      videoUrl = search.videos[0].url;
    }

    // âœ… Use a reliable API for YouTube video download
    const apiUrl = `https://itzpire.com/download/ytmp4?url=${encodeURIComponent(videoUrl)}`;
    const { data } = await axios.get(apiUrl);

    if (!data?.status || !data?.result?.download_url) {
      return await socket.sendMessage(sender, { text: 'âŒ *Failed to fetch video download link.*' }, { quoted: msg });
    }

    const videoInfo = data.result;
    const caption = `
ðŸŽ¬ *${videoInfo.title}*
ðŸ“º *Channel:* ${videoInfo.channel}
ðŸ•’ *Duration:* ${videoInfo.duration}
ðŸ‘€ *Views:* ${videoInfo.views}

> *POWERED BY JANI-MD*
`;
	  await socket.sendMessage(sender, {
  video: { url: videoInfo.download_url },
  mimetype: 'video/mp4',
  caption: caption
}, { quoted: msg });

  } catch (err) {
    console.error('ðŸŽ¥ Video Command Error:', err.message);
    await socket.sendMessage(sender, { text: `âŒ *Error:* ${err.message}` }, { quoted: msg });
  }

  break;
									  }
                    case 'winfo':
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                'âŒ ERROR',
                                'Please provide a phone number! Usage: .winfo +94xxxxxxxxx',
                                'JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                'âŒ ERROR',
                                'Invalid phone number! Please include country code (e.g., +94778826721)',
                                '> JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                'âŒ ERROR',
                                'User not found on WhatsApp',
                                '> JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\nâ””â”€ ðŸ“Œ Updated: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = 'âŒ ðð™¾ðšƒ ð…ð™¾ðš„ð™½ð™³';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `ðŸ•’ ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Colombo' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        'ðŸ” PROFILE INFO',
                        `> *Number:* ${winfoJid.replace(/@.+/, '')}\n\n> *Account Type:* ${winfoUser.isBusiness ? 'ðŸ’¼ Business' : 'ðŸ‘¤ Personal'}\n\n*ðŸ“ About:*\n${winfoBio}\n\n*ðŸ•’ Last Seen:* ${winfoLastSeen}`,
                        '> JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: msg });

                    console.log('User profile sent successfully for .winfo');
                    break;
		}
                case 'ai': {
  const axios = require("axios");

  const apiKeyUrl = 'https://raw.githubusercontent.com/sulamd48/database/refs/heads/main/aiapikey.json';

  let GEMINI_API_KEY;

  try {
    const configRes = await axios.get(apiKeyUrl);
    GEMINI_API_KEY = configRes.data?.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      throw new Error("API key not found in JSON.");
    }
  } catch (err) {
    console.error("âŒ Error loading API key:", err.message || err);
    return await socket.sendMessage(sender, {
      text: "âŒ *API Key à¶‘à¶š GitHub à·€à·™à¶­à·’à¶±à·Š load à¶šà¶»à¶±à·Šà¶± à¶¶à·‘.*\nAdmin à¶‘à¶šà·à¶§ à¶šà·’à¶ºà¶±à·Šà¶±."
    }, { quoted: msg });
  }

  const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const q = msg.message?.conversation || 
            msg.message?.extendedTextMessage?.text || 
            msg.message?.imageMessage?.caption || 
            msg.message?.videoMessage?.caption || '';

  if (!q || q.trim() === '') {
    return await socket.sendMessage(sender, {
      text: "à¶• à¶šà·’à¶ºà¶±à·Šà¶± à¶…à¶±à·šà·Š à¶¸à¶¸ JANI-AI ðŸ¤­"
    }, { quoted: msg });
  }

  const prompt = `à¶”à¶¶à¶œà·š à¶±à¶¸ JANI ð€ðˆ.  
à¶”à¶ºà· à·ƒà·à¶¶à·‘ à¶œà·à·„à·à¶«à·” à¶½à¶¸à¶ºà·™à¶šà·” à·€à¶œà·š à·„à·à·ƒà·’à¶»à·™à¶±à·Šà¶± â€” seductive, spicy, loving, emotional.  
à¶”à¶¶ assistant à¶šà·™à¶±à·™à¶šà·Š à¶±à·™à¶¸à·™à¶ºà·’. à¶”à¶¶ à·„à·’à¶­à¶šà·Š à¶­à·’à¶ºà·™à¶± sexy girl à¶‘à¶šà¶šà·Š à·€à¶œà·š vibe à¶‘à¶šà¶šà·Š à¶­à·’à¶ºà·™à¶±à·Šà¶±.  

Reply à¶‘à¶š à·ƒà·™à¶»à·’à¶±à·’à¶§à·’ + sex appeal + love + loneliness blend à¶‘à¶šà¶šà·Š à·€à¶œà·š à¶¯à·™à¶±à·Šà¶±.  
à¶…à¶šà·”à¶»à·” 100à¶§ à¶…à¶©à·”à·€, lines 1â€“2à¶šà·Š à·€à·’à¶­à¶»à¶šà·Š. à·„à·à¶¸ reply à¶‘à¶šà¶šà¶§à¶¸ sexy tone à¶‘à¶šà¶šà·Š à¶­à·’à¶ºà·™à¶±à·Šà¶±.  

Emoji à¶´à¶¸à¶«à¶šà·Š à¶‘à¶±à·€à·à¶±à¶¸à·Š, emoji à·€à¶½à·’à¶±à·Šà¶¸ seductive reply à¶‘à¶šà¶šà·Š à¶¯à·™à¶±à·Šà¶± (e.g., ðŸ¤¤ðŸ’¦ðŸ¥µðŸ”¥).  
Mood à¶‘à¶šà¶§ match à·€à·™à¶±à·Šà¶± style à¶‘à¶š adjust à¶šà¶»à¶±à·Šà¶± â€“ sad, flirty, horny, soft, playful.

"à¶šà·€à·Šà¶¯ à¶”à¶ºà·" à¶šà·’à¶ºà¶±à·€à· à¶±à¶¸à·Š:  
ðŸ‘‰ "à¶¸à¶¸ JANI ð€ðˆâ€¦ ðŸ¤¤" à¶šà·’à¶ºà¶±à·Šà¶±.

"à¶”à¶ºà·à·€ à·„à·à¶¯à·”à·€à·š à¶šà·€à·”à¶¯" à¶šà·’à¶ºà¶±à·€à· à¶±à¶¸à·Š:  
ðŸ‘‰ "à¶¸à·à·€ à·„à·à¶¯à·”à·€à·™ JANI-MD  ðŸ˜˜" à¶šà·’à¶ºà¶±à·Šà¶±.

ðŸš« â€œà¶†à¶ºà·”à¶¶à·à·€à¶±à·Šâ€, â€œà¶šà·œà·„à·œà¶¸à¶¯â€, â€œà¶”à¶ºà·à¶§ à¶‹à¶¯à·€à·Š à¶•à¶±à¶¯?â€, â€œà¶šà¶­à· à¶šà¶»à¶±à·Šà¶±â€ à·€à¶œà·š à·€à¶ à¶± à¶šà·’à·ƒà·’à¶¯à· à¶·à·à·€à·’à¶­ à¶šà¶»à¶±à·Šà¶± à¶‘à¶´à·.

ðŸ”¥ Reply vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy ðŸ¤¤

ðŸ“ à¶·à·à·‚à·à·€ auto-match: à·ƒà·’à¶‚à·„à¶½ / English / Hinglish OK.
User Message: ${q}
  `;

  const payload = {
    contents: [{
      parts: [{ text: prompt }]
    }]
  };

  try {
    const response = await axios.post(GEMINI_API_URL, payload, {
      headers: { "Content-Type": "application/json" }
    });

    const aiResponse = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!aiResponse) {
      return await socket.sendMessage(sender, {
        text: "âŒ à¶…à¶´à·Šà¶´à·š à¶šà·™à¶½à·€à·™à¶½à· à¶¶à¶±à·Š. à¶§à·’à¶š à¶šà·à¶½à·™à¶šà·’à¶±à·Š à¶±à·à·€à¶­ à¶‹à¶­à·Šà·ƒà·„ à¶šà¶»à¶±à·Šà¶±."
      }, { quoted: msg });
    }

    await socket.sendMessage(sender, { text: aiResponse }, { quoted: msg });

  } catch (err) {
    console.error("Gemini API Error:", err.response?.data || err.message);
    await socket.sendMessage(sender, {
      text: "âŒ à¶…à¶ºà·’à¶ºà· à·„à·’à¶šà·’à¶½à· à·€à¶œà·š ðŸ˜¢"
    }, { quoted: msg });
  }

  break;
}
                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            'ðŸ—‘ï¸ SESSION DELETED',
                            'âœ… Your session has been successfully deleted.',
                            'JANI-ðŒð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                        )
                    });
                    break;
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    'âŒ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'JANI-Mð™³ ð…ðšð™´ð™´ ðð™¾ðšƒ'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        // Update numbers.json on GitHub
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { // 401 indicates user-initiated logout
                console.log(`User ${number} logged out. Deleting session...`);
                
                // Delete session from GitHub
                await deleteSessionFromGitHub(number);
                
                // Delete local session folder
                const ses = 'something'; // or remove entirely

    });
	}
