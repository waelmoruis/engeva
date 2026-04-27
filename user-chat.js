// user-chat.js - نسخة محسنة بالكامل

// تهيئة Supabase
const supabaseUrl = window.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const supabaseKey = window.SUPABASE_ANON_KEY || 'YOUR_SUPABASE_ANON_KEY';
const supabaseClient = window.AppSupabase || supabase.createClient(supabaseUrl, supabaseKey);

// المتغيرات العامة
let currentUser = null;
let chatChannel = null;
let presenceChannel = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let heartbeatInterval = null;

// عناصر DOM
const elements = {
    loadingScreen: document.getElementById('loadingScreen'),
    mainContent: document.getElementById('mainContent'),
    errorMessage: document.getElementById('errorMessage'),
    errorText: document.getElementById('errorText'),
    messagesContainer: document.getElementById('messagesContainer'),
    onlineUsersList: document.getElementById('onlineUsersList'),
    mobileOnlineUsersList: document.getElementById('mobileOnlineUsersList'),
    onlineCount: document.getElementById('onlineCount'),
    mobileOnlineCount: document.getElementById('mobileOnlineCount'),
    chatOnlineCount: document.getElementById('chatOnlineCount'),
    profileName: document.getElementById('profileName'),
    profileFullName: document.getElementById('profileFullName'),
    profileEmail: document.getElementById('profileEmail'),
    profileInitial: document.getElementById('profileInitial'),
    profileRole: document.getElementById('profileRole'),
    messageInput: document.getElementById('messageInput'),
    sendButton: document.getElementById('sendButton'),
    messageForm: document.getElementById('messageForm'),
    toggleOnlineUsers: document.getElementById('toggleOnlineUsers'),
    closeMobileSidebar: document.getElementById('closeMobileSidebar'),
    mobileOnlineSidebar: document.getElementById('mobileOnlineSidebar'),
    sidebarOverlay: document.getElementById('sidebarOverlay')
};

// عرض رسالة خطأ
function showError(message) {
    if (elements.errorText) {
        elements.errorText.textContent = message;
        elements.errorMessage.classList.remove('hidden');
        setTimeout(() => {
            elements.errorMessage.classList.add('hidden');
        }, 5000);
    }
}

// عرض/إخفاء شاشة التحميل
function setLoading(show) {
    if (elements.loadingScreen) {
        if (show) {
            elements.loadingScreen.classList.remove('hidden');
        } else {
            elements.loadingScreen.classList.add('hidden');
        }
    }
}

// التحقق من الجلسة والمستخدم
async function checkSessionAndUser() {
    setLoading(true);
    
    try {
        // 1. التحقق من وجود جلسة نشطة
        const { data: { session }, error: sessionError } = await supabaseClient.auth.getSession();
        
        if (sessionError) throw sessionError;
        
        if (!session) {
            // لا توجد جلسة - توجيه للتسجيل
            window.location.href = 'user-login.html?error=no_session';
            return false;
        }

        // 2. التحقق من وجود المستخدم في قاعدة البيانات
        const { data: userData, error: userError } = await supabaseClient
            .from('users')
            .select('*')
            .eq('id', session.user.id)
            .single();

        if (userError) {
            if (userError.code === 'PGRST116') {
                // المستخدم غير موجود في قاعدة البيانات
                await supabaseClient.auth.signOut();
                window.location.href = 'user-login.html?error=user_not_found';
                return false;
            }
            throw userError;
        }

        if (!userData) {
            await supabaseClient.auth.signOut();
            window.location.href = 'user-login.html?error=user_not_found';
            return false;
        }

        // 3. التحقق من صلاحية المستخدم
        if (userData.status === 'banned' || userData.status === 'inactive') {
            showError('حسابك غير نشط. الرجاء التواصل مع الإدارة');
            setTimeout(() => {
                supabaseClient.auth.signOut();
                window.location.href = 'user-login.html?error=account_inactive';
            }, 3000);
            return false;
        }

        // المستخدم صالح
        currentUser = userData;
        return true;

    } catch (error) {
        console.error('خطأ في التحقق:', error);
        showError('حدث خطأ في التحقق من البيانات');
        return false;
    } finally {
        setLoading(false);
    }
}

// تحديث واجهة المستخدم
function updateUserInterface() {
    if (!currentUser) return;

    const displayName = currentUser.full_name || currentUser.username || 'مستخدم';
    const userRole = currentUser.role === 'admin' ? 'مدير' : 'مستخدم عادي';
    const roleIcon = currentUser.role === 'admin' ? '👑' : '👤';

    elements.profileName.textContent = displayName;
    elements.profileFullName.textContent = displayName;
    elements.profileEmail.textContent = currentUser.email;
    elements.profileInitial.textContent = displayName.charAt(0).toUpperCase();
    elements.profileRole.textContent = `${roleIcon} ${userRole}`;

    // تمييز المديرين
    if (currentUser.role === 'admin') {
        elements.profileInitial.classList.add('text-yellow-600');
    }
}

// نظام الحضور المحسن
async function initPresence() {
    try {
        // تحديث حالة المستخدم في قاعدة البيانات
        await supabaseClient
            .from('users')
            .update({ 
                is_online: true, 
                last_seen: new Date().toISOString(),
                last_active: new Date().toISOString()
            })
            .eq('id', currentUser.id);

        // إنشاء قناة الحضور
        presenceChannel = supabaseClient.channel(`presence:${currentUser.id}`, {
            config: {
                presence: {
                    key: currentUser.id.toString(),
                },
            },
        });

        // معالجة أحداث الحضور
        presenceChannel
            .on('presence', { event: 'sync' }, () => {
                const presenceState = presenceChannel.presenceState();
                updateOnlineUsersList(presenceState);
            })
            .on('presence', { event: 'join' }, ({ key, newPresences }) => {
                console.log('مستخدم جديد انضم:', newPresences);
                fetchOnlineUsers(); // تحديث من قاعدة البيانات
            })
            .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
                console.log('مستخدم غادر:', leftPresences);
                fetchOnlineUsers(); // تحديث من قاعدة البيانات
            })
            .subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    await presenceChannel.track({
                        user_id: currentUser.id,
                        user_name: currentUser.full_name || currentUser.username,
                        user_email: currentUser.email,
                        user_role: currentUser.role,
                        user_avatar: currentUser.avatar_url,
                        online_at: new Date().toISOString(),
                    });
                    
                    // جلب قائمة المتصلين مباشرة
                    await fetchOnlineUsers();
                }
            });

        // بدء نبضات القلب للحفاظ على الاتصال
        startHeartbeat();

    } catch (error) {
        console.error('خطأ في نظام الحضور:', error);
        handleReconnection();
    }
}

// بدء نبضات القلب
function startHeartbeat() {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(async () => {
        if (currentUser) {
            try {
                await supabaseClient
                    .from('users')
                    .update({ last_seen: new Date().toISOString() })
                    .eq('id', currentUser.id);
            } catch (error) {
                console.error('خطأ في نبضات القلب:', error);
            }
        }
    }, 30000); // كل 30 ثانية
}

// جلب المتصلين من قاعدة البيانات
async function fetchOnlineUsers() {
    try {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        const { data: onlineUsers, error } = await supabaseClient
            .from('users')
            .select('id, full_name, username, role, email, avatar_url, is_online, last_seen')
            .or(`is_online.eq.true,and(is_online.eq.false,last_seen.gt.${fiveMinutesAgo})`)
            .order('role', { ascending: false })
            .order('full_name');

        if (error) throw error;

        if (onlineUsers) {
            displayOnlineUsers(onlineUsers);
        }
    } catch (error) {
        console.error('خطأ في جلب المتصلين:', error);
    }
}

// عرض قائمة المتصلين
function displayOnlineUsers(users) {
    if (!users) return;

    const onlineUsers = users.filter(u => u.is_online === true);
    const recentUsers = users.filter(u => u.is_online === false);
    
    const count = onlineUsers.length;
    
    // تحديث العدادات
    if (elements.onlineCount) elements.onlineCount.textContent = count;
    if (elements.mobileOnlineCount) elements.mobileOnlineCount.textContent = count;
    if (elements.chatOnlineCount) elements.chatOnlineCount.textContent = count;

    // إنشاء قائمة المتصلين
    const createUserElement = (user, isOnline) => {
        const userName = user.full_name || user.username || 'مستخدم';
        const isCurrentUser = user.id === currentUser?.id;
        const userRole = user.role === 'admin' ? 'مدير' : 'مستخدم';
        const roleColor = user.role === 'admin' ? 'text-yellow-600' : 'text-blue-600';
        const roleIcon = user.role === 'admin' ? '👑' : '👤';
        
        return `
            <div class="flex items-center gap-3 p-3 ${isCurrentUser ? 'bg-green-50' : 'hover:bg-gray-50'} rounded-xl transition-all border ${isCurrentUser ? 'border-green-200' : 'border-transparent'}">
                <div class="relative">
                    <div class="w-10 h-10 ${user.role === 'admin' ? 'bg-yellow-100' : 'bg-green-100'} rounded-full flex items-center justify-center font-bold ${roleColor}">
                        ${userName.charAt(0).toUpperCase()}
                    </div>
                    ${isOnline ? '<span class="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white online-pulse"></span>' : ''}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm truncate flex items-center gap-1">
                        ${roleIcon} ${userName}
                        ${user.role === 'admin' ? '<span class="text-xs bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded-full">مدير</span>' : ''}
                    </div>
                    <div class="text-xs ${isOnline ? 'text-green-600' : 'text-gray-400'}">
                        ${isOnline ? 'متصل الآن' : 'غير متصل'}
                    </div>
                </div>
                ${isCurrentUser ? '<span class="text-xs text-green-600 bg-green-100 px-2 py-1 rounded-full">أنا</span>' : ''}
            </div>
        `;
    };

    // عرض القوائم
    if (elements.onlineUsersList) {
        if (onlineUsers.length === 0 && recentUsers.length === 0) {
            elements.onlineUsersList.innerHTML = `
                <div class="text-center p-8">
                    <i class="fas fa-users-slash text-gray-400 text-4xl mb-3"></i>
                    <p class="text-gray-500">لا يوجد مستخدمين</p>
                </div>
            `;
        } else {
            elements.onlineUsersList.innerHTML = `
                ${onlineUsers.length > 0 ? `
                    <div class="mb-4">
                        <div class="text-xs text-gray-500 mb-2 px-3">متصلين الآن (${onlineUsers.length})</div>
                        ${onlineUsers.map(u => createUserElement(u, true)).join('')}
                    </div>
                ` : ''}
                ${recentUsers.length > 0 ? `
                    <div>
                        <div class="text-xs text-gray-500 mb-2 px-3">كانوا متصلين مؤخراً</div>
                        ${recentUsers.map(u => createUserElement(u, false)).join('')}
                    </div>
                ` : ''}
            `;
        }
    }

    // نسخة الموبايل
    if (elements.mobileOnlineUsersList) {
        elements.mobileOnlineUsersList.innerHTML = elements.onlineUsersList.innerHTML;
    }
}

// نظام الدردشة المحسن
async function initChat() {
    try {
        // تحميل الرسائل السابقة
        await loadPreviousMessages();

        // إنشاء قناة الدردشة
        chatChannel = supabaseClient.channel('chat-room', {
            config: {
                broadcast: { self: true },
            },
        });

        // استقبال الرسائل
        chatChannel
            .on('broadcast', { event: 'message' }, ({ payload }) => {
                displayMessage(payload, payload.user_id === currentUser.id);
                saveMessageToDatabase(payload); // حفظ نسخة احتياطية
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('تم الاتصال بقناة الدردشة');
                    addSystemMessage('✅ تم الاتصال بالدردشة');
                }
            });

        // تفعيل نموذج الإرسال
        elements.messageForm.addEventListener('submit', sendMessage);
        elements.messageInput.addEventListener('input', toggleSendButton);
        elements.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(e);
            }
        });

    } catch (error) {
        console.error('خطأ في نظام الدردشة:', error);
        showError('حدث خطأ في الاتصال بالدردشة');
    }
}

// تحميل الرسائل السابقة
async function loadPreviousMessages() {
    try {
        const { data: messages, error } = await supabaseClient
            .from('messages')
            .select('*')
            .order('created_at', { ascending: true })
            .limit(100);

        if (error) throw error;

        // مسح رسالة التحميل
        elements.messagesContainer.innerHTML = '';

        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                displayMessage({
                    id: msg.id,
                    user_id: msg.user_id,
                    user_name: msg.user_name,
                    user_role: msg.user_role,
                    content: msg.content,
                    timestamp: msg.created_at
                }, msg.user_id === currentUser.id);
            });
        } else {
            addSystemMessage('👋 مرحباً بك في الدردشة العامة');
            addSystemMessage('يمكنك البدء بالكتابة الآن');
        }

        // التمرير لآخر رسالة
        scrollToBottom();

    } catch (error) {
        console.error('خطأ في تحميل الرسائل:', error);
        addSystemMessage('❌ حدث خطأ في تحميل الرسائل السابقة');
    }
}

// تفعيل/تعطيل زر الإرسال
function toggleSendButton() {
    if (elements.sendButton) {
        if (elements.messageInput.value.trim()) {
            elements.sendButton.disabled = false;
            elements.sendButton.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            elements.sendButton.disabled = true;
            elements.sendButton.classList.add('opacity-50', 'cursor-not-allowed');
        }
    }
}

// إرسال رسالة
async function sendMessage(e) {
    e.preventDefault();
    
    const message = elements.messageInput.value.trim();
    if (!message || !currentUser) return;
    
    // تعطيل الزر مؤقتاً
    elements.sendButton.disabled = true;
    
    const messageData = {
        id: Date.now(),
        user_id: currentUser.id,
        user_name: currentUser.full_name || currentUser.username,
        user_role: currentUser.role,
        content: message,
        timestamp: new Date().toISOString(),
    };
    
    try {
        // عرض الرسالة فوراً
        displayMessage(messageData, true);
        
        // حفظ في قاعدة البيانات
        await saveMessageToDatabase(messageData);
        
        // إرسال للآخرين
        await chatChannel.send({
            type: 'broadcast',
            event: 'message',
            payload: messageData,
        });
        
        // تنظيف المدخلات
        elements.messageInput.value = '';
        toggleSendButton();
        
    } catch (error) {
        console.error('خطأ في إرسال الرسالة:', error);
        showError('فشل إرسال الرسالة');
        elements.sendButton.disabled = false;
    }
}

// حفظ الرسالة في قاعدة البيانات
async function saveMessageToDatabase(message) {
    try {
        const { error } = await supabaseClient
            .from('messages')
            .upsert([{
                id: message.id,
                user_id: message.user_id,
                user_name: message.user_name,
                user_role: message.user_role,
                content: message.content,
                created_at: message.timestamp
            }], { onConflict: 'id' });

        if (error) throw error;
    } catch (error) {
        console.error('خطأ في حفظ الرسالة:', error);
    }
}

// عرض رسالة
function displayMessage(message, isMine = false) {
    const template = document.getElementById(isMine ? 'userMessageTemplate' : 'userMessageTemplate');
    const messageDiv = template.content.cloneNode(true).querySelector('.flex');
    
    const time = new Date(message.timestamp).toLocaleTimeString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    const roleIcon = message.user_role === 'admin' ? '👑' : '👤';
    const messageContent = messageDiv.querySelector('div');
    
    // تخصيص المظهر حسب نوع الرسالة والمرسل
    let bgColor = isMine ? 'bg-gradient-to-l from-green-600 to-green-700' : 
                 (message.user_role === 'admin' ? 'bg-gradient-to-l from-yellow-400 to-yellow-500' : 'bg-white');
    let textColor = isMine ? 'text-white' : 
                   (message.user_role === 'admin' ? 'text-white' : 'text-gray-800');
    
    messageContent.className = `max-w-[85%] md:max-w-[70%] ${bgColor} ${textColor} rounded-2xl p-3 shadow`;
    
    messageContent.innerHTML = `
        <div class="flex items-center gap-2 mb-1 text-xs ${isMine ? 'text-green-100' : (message.user_role === 'admin' ? 'text-yellow-100' : 'text-gray-500')}">
            <span class="font-bold truncate">${roleIcon} ${message.user_name}</span>
            ${message.user_role === 'admin' ? '<span class="bg-yellow-600 text-white px-1.5 py-0.5 rounded-full text-[10px]">مدير</span>' : ''}
            <span class="text-xs opacity-75">${time}</span>
        </div>
        <p class="text-sm break-words whitespace-pre-wrap">${escapeHtml(message.content)}</p>
    `;
    
    // تحديد موضع الرسالة
    if (isMine) {
        messageDiv.classList.add('justify-end');
    } else {
        messageDiv.classList.add('justify-start');
    }
    
    elements.messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

// الهروب من HTML للحماية من XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// رسالة نظام
function addSystemMessage(text) {
    const template = document.getElementById('systemMessageTemplate');
    const systemDiv = template.content.cloneNode(true).querySelector('.flex');
    const contentDiv = systemDiv.querySelector('div');
    contentDiv.textContent = text;
    elements.messagesContainer.appendChild(systemDiv);
    scrollToBottom();
}

// التمرير لأسفل
function scrollToBottom() {
    setTimeout(() => {
        elements.messagesContainer.scrollTop = elements.messagesContainer.scrollHeight;
    }, 100);
}

// تبديل قائمة المتصلين في الموبايل
function toggleMobileSidebar(show) {
    if (elements.mobileOnlineSidebar && elements.sidebarOverlay) {
        if (show) {
            elements.mobileOnlineSidebar.classList.remove('translate-x-full');
            elements.sidebarOverlay.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        } else {
            elements.mobileOnlineSidebar.classList.add('translate-x-full');
            elements.sidebarOverlay.classList.add('hidden');
            document.body.style.overflow = '';
        }
    }
}

// معالجة إعادة الاتصال
function handleReconnection() {
    reconnectAttempts++;
    
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        console.log(`محاولة إعادة الاتصال ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
        setTimeout(() => {
            if (currentUser) {
                initPresence();
                initChat();
            }
        }, 2000 * reconnectAttempts); // زيادة الوقت مع كل محاولة
    } else {
        showError('فشل الاتصال. الرجاء تحديث الصفحة');
    }
}

// تسجيل الخروج
async function logout() {
    setLoading(true);
    
    try {
        // إيقاف نبضات القلب
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }

        // إلغاء تتبع الحضور
        if (presenceChannel) {
            await presenceChannel.untrack();
            await presenceChannel.unsubscribe();
        }
        
        // تحديث حالة المستخدم في قاعدة البيانات
        await supabaseClient
            .from('users')
            .update({ 
                is_online: false,
                last_seen: new Date().toISOString()
            })
            .eq('id', currentUser.id);
        
        // إلغاء الاشتراك من قنوات الدردشة
        if (chatChannel) {
            await chatChannel.unsubscribe();
        }
        
        // تسجيل الخروج من Supabase Auth
        await supabaseClient.auth.signOut();
        
        // التوجيه لصفحة تسجيل الدخول
        window.location.href = 'user-login.html?logout=success';
        
    } catch (error) {
        console.error('خطأ في تسجيل الخروج:', error);
        showError('حدث خطأ أثناء تسجيل الخروج');
        window.location.href = 'user-login.html';
    } finally {
        setLoading(false);
    }
}

// التهيئة
async function init() {
    try {
        // التحقق من الجلسة والمستخدم
        const isValid = await checkSessionAndUser();
        
        if (!isValid) return;
        
        // إظهار المحتوى الرئيسي
        elements.mainContent.classList.remove('hidden');
        
        // تحديث واجهة المستخدم
        updateUserInterface();
        
        // بدء الأنظمة
        await initPresence();
        await initChat();
        
        // تجهيز مستمعي الأحداث للموبايل
        if (elements.toggleOnlineUsers) {
            elements.toggleOnlineUsers.addEventListener('click', () => toggleMobileSidebar(true));
        }
        
        if (elements.closeMobileSidebar) {
            elements.closeMobileSidebar.addEventListener('click', () => toggleMobileSidebar(false));
        }
        
        if (elements.sidebarOverlay) {
            elements.sidebarOverlay.addEventListener('click', () => toggleMobileSidebar(false));
        }
        
        // تحديث دوري لقائمة المتصلين
        setInterval(fetchOnlineUsers, 30000); // كل 30 ثانية
        
        console.log('تم تهيئة التطبيق بنجاح');
        
    } catch (error) {
        console.error('خطأ في تهيئة التطبيق:', error);
        showError('حدث خطأ في تحميل التطبيق');
    }
}

// تنظيف عند الخروج
// دالة تحديث حالة عدم الاتصال عند إغلاق التطبيق
window.addEventListener('beforeunload', async () => {
    if (currentUser) {
        await supabaseClient
            .from('users')
            .update({ 
                is_online: false,
                last_seen: new Date()
            })
            .eq('id', currentUser.id);
    }
});

// دالة تحديث حالة الاتصال عند فتح التطبيق
async function setUserOnline() {
    if (currentUser) {
        await supabaseClient
            .from('users')
            .update({ 
                is_online: true,
                last_seen: new Date()
            })
            .eq('id', currentUser.id);
    }
}

// استدعاء الدالة بعد تحميل المستخدم
setUserOnline();
// بدء التطبيق
document.addEventListener('DOMContentLoaded', init);