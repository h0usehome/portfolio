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
                if (scrollY >= sectionTop - 300) { 
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

});