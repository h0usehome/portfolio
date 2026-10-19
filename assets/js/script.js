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
const skillRows = document.querySelectorAll('.skill-row');

const proofData = {
    'python': `<h3>ETL-пайплайны и сбор данных</h3><p>Пишу ETL-скрипты для обработки данных (например, статистики матчей Dota 2 и метрик игроков NBA) и автоматизации рутинных задач. Настраиваю рабочее окружение в VS Code и использую Jupyter Notebook для прототипирования аналитического кода.</p><p>Но всё же больше предпочитаю SQL в вопросе анализа данных.</p><a href="sport_new.html" class="btn" style="min-height:36px; font-size:13px">Смотреть проект NBA</a>`,
    'pandas': `<h3>Очистка и агрегация</h3><p>Применяю для глубокой очистки, агрегации и трансформации табличных датасетов. Библиотека помогает мне форматировать сырые данные перед их загрузкой в базы данных или визуализацией на дашбордах.</p>`,
    'numpy': `<h3>Математические вычисления</h3><p>Практикую для выполнения быстрых математических вычислений и векторных манипуляций с массивами. Это значительно ускоряет обработку больших объемов числовых данных в скриптах.</p>`,
    'clickhouse': `<h3>Колоночные базы данных</h3><p>Использую как высокопроизводительную колоночную СУБД для аналитики. Формирую запросы для быстрого извлечения и агрегации данных при работе с объемными базами.</p>`,
    'postgresql': `<h3>Реляционные базы данных</h3><p>Моя основная реляционная база для хранения структурированных данных. Пишу SQL-запросы различной сложности, используя объединения (JOIN) и сложные фильтрации дат и строк (включая работу с паттернами LIKE) для извлечения нужной информации.</p>`,
    'supabase': `<h3>BaaS и облачная инфраструктура</h3><p>Интегрирую в качестве бэкенда для своих кастомных веб-приложений (например, платформ по поиску фильмов или трекеров музыки). Настраиваю подключения к базе и обрабатываю данные по API в реальном времени.</p>`,
    'powerbi': `<h3>Визуализация в Power BI</h3><p>Разрабатываю интерактивные дашборды для наглядной презентации ключевых метрик. Этот инструмент помогает переводить результаты сложного анализа в удобные визуальные отчеты.</p><a href="jobs.html" class="btn" style="min-height:36px; font-size:13px">Аналитика вакансий</a>`,
    'excel': `<h3>Сводные таблицы и отчеты</h3><p>Выполняю разведочный анализ данных, строю сводные таблицы и диаграммы рассеяния (например, для оценки корреляций или снижения ошибок в рабочих процессах). Активно применяю функции поиска и логические формулы для быстрой сверки выгрузок (в том числе из 1С).</p>`,
    'javascript': `<h3>Фронтенд-разработка</h3><p>Пишу фронтенд-логику для своих веб-проектов, интегрирую сторонние REST API (TMDB, Spotify, OpenDota) и настраиваю динамическое взаимодействие интерфейса с пользователем.</p>`,
    'chartjs': `<h3>Веб-визуализация (Chart.js)</h3><p>Внедряю для построения легковесных и адаптивных графиков на веб-страницах. С её помощью оживляю интерфейс своих аналитических проектов.</p>`,
    'd3': `<h3>Продвинутая графика (D3.js)</h3><p>Использую для создания сложных кастомных визуализаций, где требуется тонкая настройка каждого элемента графика с привязкой к конкретным массивам данных для построения интерактивных live-дашбордов.</p>`,
    'githubactions': `<h3>Автоматизация CI/CD</h3><p>Настраиваю автоматизацию рабочих процессов, в том числе запуск Python-скриптов по расписанию. С их помощью обновляю данные для аналитических дашбордов, которые хостятся на GitHub Pages.</p><a href="pipeline.html" class="btn" style="min-height:36px; font-size:13px">Посмотреть пайплайн</a>`
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