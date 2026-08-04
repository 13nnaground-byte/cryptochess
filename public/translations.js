const translations = {
  hy: {
    profile: "Պրոֆիլ",
    connectWallet: "Միացնել դրամապանակը",
    findGame: "Գտնել խաղ",
    waiting: "Սպասում ենք մրցակցին...",
    cancelQueue: "Չեղարկել հերթը",
    wins: "Հաղթանակներ",
    losses: "Պարտություններ",
    draws: "Ոչ-ոքի",
    history: "Խաղերի պատմություն",
    drawOffer: "Մրցակիցը առաջարկում է ոչ-ոքի:",
    accept: "Ընդունել",
    decline: "Մերժել"
  },
  en: {
    profile: "Profile",
    connectWallet: "Connect Wallet",
    findGame: "Find Game",
    waiting: "Waiting for opponent...",
    cancelQueue: "Cancel Queue",
    wins: "Wins",
    losses: "Losses",
    draws: "Draws",
    history: "Game History",
    drawOffer: "Opponent offered a draw.",
    accept: "Accept",
    decline: "Decline"
  },
  ru: {
    profile: "Профиль",
    connectWallet: "Подключить кошелек",
    findGame: "Найти игру",
    waiting: "Ожидание противника...",
    cancelQueue: "Отменить очередь",
    wins: "Победы",
    losses: "Поражения",
    draws: "Ничьи",
    history: "История игр",
    drawOffer: "Соперник предлагает ничью.",
    accept: "Принять",
    decline: "Отклонить"
  },
  zh: {
    profile: "个人资料",
    connectWallet: "连接钱包",
    findGame: "寻找游戏",
    waiting: "等待对手...",
    cancelQueue: "取消排队",
    wins: "胜",
    losses: "负",
    draws: "平",
    history: "游戏历史",
    drawOffer: "对手提议和棋。",
    accept: "接受",
    decline: "拒绝"
  },
  hi: {
    profile: "प्रोफाइल",
    connectWallet: "वॉलेट कनेक्ट करें",
    findGame: "गेम खोजें",
    waiting: "प्रतिद्वंद्वी की प्रतीक्षा है...",
    cancelQueue: "कतार रद्द करें",
    wins: "जीत",
    losses: "हार",
    draw": "ड्रॉ",
    draws: "ड्रॉ",
    history: "गेम इतिहास",
    drawOffer: "प्रतिद्वंद्वी ने ड्रॉ का प्रस्ताव दिया है।",
    accept: "स्वीकार करें",
    decline: "अस्वीकार करें"
  }
};

let currentLang = localStorage.getItem('chessLang') || 'en';

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('chessLang', lang);
  updateTexts();
}

function t(key) {
  return translations[currentLang][key] || translations['en'][key] || key;
}