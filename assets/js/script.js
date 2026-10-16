// Файл: assets/js/script.js

document.addEventListener('DOMContentLoaded', () => {

    // 1. Подсветка активного раздела в боковом меню при скролле
    const sections = document.querySelectorAll('section[id]');
    const navItems = document.querySelectorAll('.nav-item');

    if (sections.length > 0 && navItems.length > 0) {
        window.addEventListener('scroll', () => {
            let current = '';
            
            sections.forEach(section => {
                const sectionTop = section.offsetTop;
                if (scrollY >= sectionTop - 800) { 
                    current = section.getAttribute('id');
                }
            });

            navItems.forEach(item => {
                item.classList.remove('active');
                if (item.getAttribute('href') === `#${current}`) {
                    item.classList.add('active');
                }
            });
        });
    }

    // 2. Обработка формы контактов
    const contactForm = document.getElementById('contact');
    if (contactForm) {
        contactForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var f = e.target;
            var body = f.message.value + '\n\n' + f.name.value + ' (' + f.email.value + ')';
            // Замени [email] на свою реальную почту, например: bogdan.data@gmail.com
            location.href = 'mailto:[email]?subject=' + encodeURIComponent('Сообщение с портфолио') + '&body=' + encodeURIComponent(body);
        });
    }

    // === ЛОГИКА ИНТЕРАКТИВНЫХ НАВЫКОВ ===
const tiles = document.querySelectorAll('.tile[data-skill]');
const grid = document.getElementById('skills-grid');
const proofPanel = document.getElementById('proof-panel');
const proofHeader = document.getElementById('proof-header');
const proofContent = document.getElementById('proof-content');
const closeBtn = document.getElementById('close-proof');
const skillsLeft = document.getElementById('skills-left');
const skillRows = document.querySelectorAll('.skill-row'); // Выбираем все прогресс-бары

const proofData = {
    'python': `<h3>ETL-пайплайны и сбор данных</h3><p>Пишу скрипты для парсинга API (NBA, Formula 1). Настраиваю автоматический сбор и первичную обработку информации.</p><a href="sport_new.html" class="btn" style="min-height:36px; font-size:13px">Смотреть проект NBA</a>`,
    'pandas': `<h3>Очистка и агрегация</h3><p>Использую Pandas для трансформации данных: заполнение пропусков, группировка метрик и подготовка датасетов к загрузке в БД.</p>`,
    'numpy': `<h3>Математические вычисления</h3><p>Применяю NumPy для быстрой векторизованной обработки массивов данных и статистических расчетов в пайплайнах.</p>`,
    'clickhouse': `<h3>Колоночные базы данных</h3><p>Опыт работы с ClickHouse для построения быстрых аналитических запросов на больших объемах данных.</p>`,
    'postgresql': `<h3>Реляционные базы данных</h3><p>Проектирую структуру таблиц. Пишу сложные SQL-запросы: оконные функции, CTE и объединения данных для дашбордов.</p>`,
    'supabase': `<h3>BaaS и облачная инфраструктура</h3><p>Использую Supabase как основное хранилище (PostgreSQL) с настроенным API для отдачи данных на фронтенд.</p>`,
    'powerbi': `<h3>Визуализация в Power BI</h3><p>Проектирую дашборды для бизнеса с использованием DAX-мер, динамических фильтров и удобного UI/UX.</p><a href="jobs.html" class="btn" style="min-height:36px; font-size:13px">Аналитика вакансий</a>`,
    'excel': `<h3>Сводные таблицы и отчеты</h3><p>Создаю интерактивные отчеты, применяю Power Query для импорта данных и сложные формулы для логики расчетов.</p>`,
    'javascript': `<h3>Фронтенд-разработка</h3><p>Оживляю интерфейсы, работаю с DOM-деревом и пишу логику для асинхронных запросов к API.</p>`,
    'chartjs': `<h3>Веб-визуализация (Chart.js)</h3><p>Интегрирую интерактивные графики прямо в браузер: настраиваю оси, тултипы и анимации появления.</p>`,
    'd3': `<h3>Продвинутая графика (D3.js)</h3><p>Использую инструменты D3 для построения нестандартных визуализаций, привязанных к данным.</p>`,
    'githubactions': `<h3>Автоматизация CI/CD</h3><p>Настроил воркеры, которые каждый день дергают API, обновляют базу данных и пересобирают проекты.</p><a href="pipeline.html" class="btn" style="min-height:36px; font-size:13px">Посмотреть пайплайн</a>`
};


if (grid && proofPanel) {
    tiles.forEach(tile => {
        tile.addEventListener('click', () => {
            const skill = tile.getAttribute('data-skill');
            const category = tile.getAttribute('data-category'); // Читаем категорию
            
            // 1. Очищаем старый заголовок и копируем туда нажатую плитку
            proofHeader.innerHTML = '';
            const tileClone = tile.cloneNode(true);
            proofHeader.appendChild(tileClone);

            // 2. Вставляем текст из базы
            proofContent.innerHTML = proofData[skill] || '<p>Описание в разработке...</p>';

            // 3. Подсвечиваем соответствующий прогресс-бар слева
            skillRows.forEach(row => row.classList.remove('highlight')); // Сбрасываем со всех
            const targetRow = document.querySelector(`.skill-row[data-category="${category}"]`);
            if (targetRow) {
                targetRow.classList.add('highlight'); // Добавляем подсветку нужному
            }

            // 4. Запускаем анимации
            grid.classList.add('hidden');
            proofPanel.classList.add('active');
            skillsLeft.classList.add('shrunk');
        });
    });

    // Закрытие панели
    closeBtn.addEventListener('click', () => {
        grid.classList.remove('hidden');
        proofPanel.classList.remove('active');
        skillsLeft.classList.remove('shrunk');
        skillRows.forEach(row => row.classList.remove('highlight')); // Сбрасываем подсветку
    });
}

// Делаем функцию доступной глобально из HTML-атрибута onclick
window.copyEmail = function(cardElement, emailText) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(emailText).then(() => {
            showSuccess(cardElement);
        }).catch(() => {
            fallbackCopy(emailText, cardElement);
        });
    } else {
        fallbackCopy(emailText, cardElement);
    }
};

function fallbackCopy(text, cardElement) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showSuccess(cardElement);
        }
    } catch (err) {
        console.error('Ошибка при копировании: ', err);
    }
    
    document.body.removeChild(textArea);
}

function showSuccess(cardElement) {
    const hint = cardElement.querySelector('.bc-action-hint');
    if (!hint) return;
    const originalText = hint.textContent;
    
    hint.textContent = 'Скопировано! ✓';
    hint.style.color = '#3DDC97';
    
    setTimeout(() => {
        hint.textContent = originalText;
        hint.style.color = '';
    }, 2000);
}


});