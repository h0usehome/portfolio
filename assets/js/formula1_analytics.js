// ==========================================
// 1. НАСТРОЙКА SUPABASE И ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ
// ==========================================
const SUPABASE_URL = 'https://xqqeiigpamtegingzjda.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhxcWVpaWdwYW10ZWdpbmd6amRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MTY2ODgsImV4cCI6MjEwNjk5MjY4OH0.wCma0-5v6fo0iPFM7EHTN4zs3K3Z5zKx-B2yTvmgA6M';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const teamUI = {
    "Ferrari": { colors: { main: "#e10600", sec: "#ffea00" }, subWins: "SCUDERIA", subPodiums: "MARANELLO" },
    "McLaren": { colors: { main: "#ff8700", sec: "#47c7fc" }, subWins: "WOKING", subPodiums: "BRITISH" },
    "Mercedes": { colors: { main: "#00d2be", sec: "#c8ccce" }, subWins: "BRACKLEY", subPodiums: "SILVER ARROWS" },
    "Red Bull": { colors: { main: "#0600ef", sec: "#ff0000" }, subWins: "MILTON KEYNES", subPodiums: "RACING" },
    "Williams": { colors: { main: "#005aff", sec: "#ffffff" }, subWins: "GROVE", subPodiums: "BRITISH" },
    "Renault": { colors: { main: "#fff500", sec: "#000000" }, subWins: "ENSTONE", subPodiums: "FRENCH" }
};

const dashboardState = { team: "Ferrari", decade: null, season: null, driver: null };
let teamMasterLog = []; 
let currentTeamColors = { main: "#e10600", sec: "#ffea00" };

// Единый тултип для всех графиков
const tooltip = d3.select("body").append("div")
    .style("position", "absolute")
    .style("background", "rgba(15, 15, 20, 0.95)")
    .style("border", "1px solid #333")
    .style("color", "#fff")
    .style("padding", "10px")
    .style("border-radius", "4px")
    .style("pointer-events", "none")
    .style("opacity", 0)
    .style("z-index", "1000")
    .style("font-family", "Orbitron, sans-serif");


// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

function animateNumber(selector, targetValue, color, suffix = "") {
    const el = d3.select(selector);
    el.style("color", color);
    el.transition().duration(1000)
      .tween("text", function() {
          const i = d3.interpolateRound(parseInt(this.textContent.replace(/\D/g, '')) || 0, targetValue);
          return function(t) { this.textContent = i(t) + suffix; };
      });
}


// ==========================================
// 3. D3.js ГРАФИКИ
// ==========================================

function drawRadarChart(d1Stats, d2Stats, color1, color2) {
    const container = d3.select("#duel-radar-chart");
    if (container.empty()) return;
    container.html("");

    const width = container.node().getBoundingClientRect().width || 300;
    const height = 350; // Чуть увеличим высоту для красоты
    // Увеличили отступ (было -40, стало -60), чтобы текст не обрезался
    const radius = Math.min(width, height) / 2 - 60; 
    
    // Теперь 5 осей
    const features = ["Гонки", "Очки", "Победы", "Подиумы", "Поулы"];

    const svg = container.append("svg").attr("width", width).attr("height", height)
        .append("g").attr("transform", `translate(${width / 2},${height / 2 + 10})`);

    // Находим максимум. Если у обоих 0 (например, нет поулов), ставим 1, чтобы избежать деления на ноль
    const maxVals = features.map(f => Math.max(d1Stats[f] || 0, d2Stats[f] || 0) || 1);
    const rScale = d3.scaleLinear().range([0, radius]).domain([0, 1]); 
    const angleSlice = (Math.PI * 2) / features.length;

    // Рисуем фоновую паутину
    const axisGrid = svg.append("g").attr("class", "axisWrapper");
    [0.2, 0.4, 0.6, 0.8, 1].forEach(level => {
        axisGrid.append("polygon")
            .attr("points", features.map((_, i) => {
                const r = radius * level;
                return `${r * Math.cos(angleSlice * i - Math.PI / 2)},${r * Math.sin(angleSlice * i - Math.PI / 2)}`;
            }).join(" "))
            .style("fill", "none").style("stroke", "rgba(255,255,255,0.1)");
    });

    // Оси и текст
    const axis = axisGrid.selectAll(".axis").data(features).enter().append("g").attr("class", "axis");
    axis.append("line").attr("x1", 0).attr("y1", 0)
        .attr("x2", (d, i) => rScale(1.05) * Math.cos(angleSlice * i - Math.PI / 2))
        .attr("y2", (d, i) => rScale(1.05) * Math.sin(angleSlice * i - Math.PI / 2))
        .style("stroke", "rgba(255,255,255,0.1)").style("stroke-width", "1px");

    // Подписи осей отодвинуты чуть дальше (rScale 1.25)
    axis.append("text")
        .attr("x", (d, i) => rScale(1.25) * Math.cos(angleSlice * i - Math.PI / 2))
        .attr("y", (d, i) => rScale(1.25) * Math.sin(angleSlice * i - Math.PI / 2))
        .text(d => d).style("fill", "#8a8a9d").style("font-size", "12px")
        .style("text-anchor", "middle").attr("dy", "0.35em");

    // Главное: добавляем d3.curveLinearClosed, чтобы линия замыкалась
    const radarLine = d3.lineRadial()
        .curve(d3.curveLinearClosed)
        .angle((d, i) => i * angleSlice)
        .radius((d, i) => rScale(d.value / maxVals[i]));

    const plotData = [
        { name: d1Stats.name, color: color1, values: features.map(f => ({ axis: f, value: d1Stats[f] })) },
        { name: d2Stats.name, color: color2, values: features.map(f => ({ axis: f, value: d2Stats[f] })) }
    ];

    // Отрисовка полигонов с красивым наложением (mix-blend-mode)
    plotData.forEach(driver => {
        svg.append("path")
           .datum(driver.values)
           .attr("d", radarLine)
           .style("fill", driver.color).style("fill-opacity", 0.4)
           .style("stroke", driver.color).style("stroke-width", 2)
           .style("mix-blend-mode", "screen") // Делает пересечения цветов яркими
           .on("mouseover", function() {
               d3.selectAll("path").style("fill-opacity", 0.1);
               d3.select(this).style("fill-opacity", 0.7);
           })
           .on("mouseout", () => d3.selectAll("path").style("fill-opacity", 0.4));
    });
}

function drawHistoryWinsChart(chartData, color) {
    const container = d3.select("#wins-chart").html("");
    if (!chartData.length) return;
    
    const margin = {top: 20, right: 20, bottom: 40, left: 40};
    const width = container.node().getBoundingClientRect().width - margin.left - margin.right;
    const height = container.node().getBoundingClientRect().height - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(chartData.map(d => d.decade)).range([0, width]).padding(0.3);
    const y = d3.scaleLinear().domain([0, d3.max(chartData, d => d.wins) || 10]).range([height, 0]);

    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).tickSize(0)).attr("color", "#8a8a9d").attr("font-family", "Rajdhani").attr("font-size", "14px");
    svg.append("g").call(d3.axisLeft(y).ticks(5)).attr("color", "#8a8a9d").attr("font-family", "Rajdhani");

    svg.selectAll("rect").data(chartData).join("rect")
       .attr("id", d => `dec-${d.decade}`)
       .attr("x", d => x(d.decade))
       .attr("y", d => y(d.wins))
       .attr("width", x.bandwidth())
       .attr("height", d => height - y(d.wins))
       .attr("fill", color).attr("rx", 4)
       .style("cursor", "pointer")
       .on("mouseover", function(_event, d) {
           d3.select(this).style("filter", "brightness(1.3)");
           tooltip.style("opacity", 1).html(`Десятилетие: <strong>${d.decade}s</strong><br/>Побед: <span style="color:${color};">${d.wins}</span>`);
       })
       .on("mousemove", _event => tooltip.style("left", (_event.pageX + 10) + "px").style("top", (_event.pageY - 20) + "px"))
       .on("mouseout", function() {
           d3.select(this).style("filter", "none");
           tooltip.style("opacity", 0);
       })
       .on("click", function(_event, d) {
           dashboardState.decade = dashboardState.decade === Number(d.decade) ? null : Number(d.decade);
           dashboardState.season = null; 
           renderDashboard();
       });
}

function drawHistoryPointsChart(chartData, color) {
    const container = d3.select("#points-chart");
    if (container.empty() || !chartData.length) return;
    container.html("");

    const margin = {top: 20, right: 20, bottom: 40, left: 50};

    const rect = container.node().getBoundingClientRect();
    const width = Math.max(rect.width, 300) - margin.left - margin.right;
    const height = Math.max(rect.height, 250) - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain(d3.extent(chartData, d => d.year)).range([0, width]);
    const y = d3.scaleLinear().domain([0, d3.max(chartData, d => d.points) * 1.1 || 10]).range([height, 0]);

    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).tickFormat(d3.format("d")).ticks(8))
       .attr("color", "#8a8a9d").attr("font-family", "inherit");
    svg.append("g").call(d3.axisLeft(y).ticks(5)).attr("color", "#8a8a9d").attr("font-family", "inherit");

    // Плавная линия
    const line = d3.line().x(d => x(d.year)).y(d => y(d.points)).curve(d3.curveMonotoneX);
    
    svg.append("path").datum(chartData)
       .attr("fill", "none").attr("stroke", color).attr("stroke-width", 3).attr("d", line);

    // Интерактивные точки
    svg.selectAll("circle").data(chartData).join("circle")
       .attr("id", d => `sea-${d.year}`)
       .attr("cx", d => x(d.year))
       .attr("cy", d => y(d.points))
       .attr("r", 5).attr("fill", "#111").attr("stroke", color).attr("stroke-width", 2)
       .style("cursor", "pointer")
       .on("mouseover", function(_event, d) {
           d3.select(this).attr("r", 8).attr("fill", color);
           tooltip.style("opacity", 1).html(`Сезон: <strong>${d.year}</strong><br/>Очки: <span style="color:${color};">${d.points}</span>`);
       })
       .on("mousemove", _event => tooltip.style("left", (_event.pageX + 10) + "px").style("top", (_event.pageY - 20) + "px"))
       .on("mouseout", function() {
           d3.select(this).attr("r", 5).attr("fill", "#111");
           tooltip.style("opacity", 0);
       })
       .on("click", function(_event, d) {
           dashboardState.season = dashboardState.season === d.year ? null : d.year;
           renderDashboard();
       });
}

function drawDriversChart(chartData, color) {
    const container = d3.select("#drivers-chart").html("");
    if (!chartData.length) return;

    const margin = {top: 20, right: 30, bottom: 20, left: 120};
    const width = container.node().getBoundingClientRect().width - margin.left - margin.right;
    const height = container.node().getBoundingClientRect().height - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, d3.max(chartData, d => d.total_points)]).range([0, width]);
    const y = d3.scaleBand().domain(chartData.map(d => d.driver_name)).range([0, height]).padding(0.2);

    svg.append("g").call(d3.axisLeft(y).tickSize(0)).attr("color", "#fff").attr("font-family", "Rajdhani").attr("font-size", "14px").select(".domain").remove();

    svg.selectAll("rect").data(chartData).join("rect")
       .attr("id", d => `bar-${d.driver_name.replace(/\s+/g, '-')}`)
       .attr("x", 0).attr("y", d => y(d.driver_name))
       .attr("width", d => x(d.total_points))
       .attr("height", y.bandwidth())
       .attr("fill", color).attr("rx", 3)
       .style("cursor", "pointer")
       .on("mouseover", function(_event, d) {
           d3.select(this).style("filter", "brightness(1.3)");
           tooltip.style("opacity", 1).html(`<strong>${d.driver_name}</strong><br/>Очки: ${Math.round(d.total_points)}<br/>Победы: ${d.wins}`);
       })
       .on("mousemove", _event => tooltip.style("left", (_event.pageX + 10) + "px").style("top", (_event.pageY - 20) + "px"))
       .on("mouseout", function() {
           d3.select(this).style("filter", "none");
           tooltip.style("opacity", 0);
       })
       .on("click", function(_event, d) {
           dashboardState.driver = dashboardState.driver === d.driver_name ? null : d.driver_name;
           renderDashboard(); 
       });
}

function drawTopTracksChart(chartData, color) {
    const container = d3.select("#tracks-chart"); 
    if (container.empty() || !chartData.length) return;
    container.html("");
    
    // Берем топ-7 трасс
    const topData = chartData.sort((a,b) => b.wins - a.wins).slice(0, 7);
    
    const margin = {top: 20, right: 30, bottom: 40, left: 140};
    const rect = container.node().getBoundingClientRect();
    const width = Math.max(rect.width, 300) - margin.left - margin.right;
    const height = Math.max(rect.height, 350) - margin.top - margin.bottom;

    const svg = container.append("svg").attr("width", width + margin.left + margin.right).attr("height", height + margin.top + margin.bottom)
               .append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    
    const x = d3.scaleLinear().domain([0, d3.max(topData, d => d.wins) * 1.1 || 5]).range([0, width]);
    const y = d3.scaleBand().domain(topData.map(d => d.circuit_name)).range([0, height]).padding(1);

    svg.append("g").call(d3.axisLeft(y).tickSize(0)).attr("color", "#fff").attr("font-family", "inherit").select(".domain").remove();
    svg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(5).tickFormat(d3.format("d")))
       .attr("color", "#8a8a9d").attr("font-family", "inherit");

    // Рисуем линии (палочки от чупа-чупса)
    svg.selectAll("line.lollipop").data(topData).join("line").attr("class", "lollipop")
       .attr("x1", x(0)).attr("x2", d => x(d.wins)).attr("y1", d => y(d.circuit_name)).attr("y2", d => y(d.circuit_name))
       .attr("stroke", "rgba(255, 255, 255, 0.2)").attr("stroke-width", 2);

    // Рисуем круги (леденцы)
    svg.selectAll("circle.lollipop").data(topData).join("circle").attr("class", "lollipop")
       .attr("cx", d => x(d.wins)).attr("cy", d => y(d.circuit_name)).attr("r", 7)
       .attr("fill", color).attr("stroke", "#0f1015").attr("stroke-width", 2)
       .on("mouseover", function(_event, d) {
           d3.select(this).attr("r", 10).style("filter", "brightness(1.5)");
           tooltip.style("opacity", 1).html(`<strong>${d.circuit_name}</strong><br/>Побед: ${d.wins}<br/>Подиумов: ${d.podiums}`);
       })
       .on("mousemove", _event => tooltip.style("left", (_event.pageX + 10) + "px").style("top", (_event.pageY - 20) + "px"))
       .on("mouseout", function() {
           d3.select(this).attr("r", 7).style("filter", "none");
           tooltip.style("opacity", 0);
       });
}

function drawReliabilityDonut(chartData, color) {
    const container = d3.select("#reliability-donut-chart");
    if (container.empty()) return;
    container.html("");
    
    // Защита от нулевой высоты
    const rect = container.node().getBoundingClientRect();
    const width = Math.max(rect.width, 250);
    const height = Math.max(rect.height, 250);
    const radius = Math.min(width, height) / 2;

    const svg = container.append("svg").attr("width", width).attr("height", height)
        .append("g").attr("transform", `translate(${width / 2},${height / 2})`);

    const colorScale = d3.scaleOrdinal().domain(["Финиш", "Технический сход", "Авария"]).range([color, "#8a8a9d", "#ff2a2a"]);
    
    const pie = d3.pie().value(d => d.total).sort(null);
    const arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius * 0.85);

    svg.selectAll("path").data(pie(chartData)).join("path")
       .attr("d", arc).attr("fill", d => colorScale(d.data.status_category)).attr("stroke", "#191a23").attr("stroke-width", 3)
       .style("cursor", "pointer")
       .on("mouseover", function(_event, d) {
           d3.select(this).style("filter", "brightness(1.3)");
           tooltip.style("opacity", 1).html(`${d.data.status_category}: <strong>${d.data.total}</strong> гонок`);
       })
       .on("mousemove", _event => tooltip.style("left", (_event.pageX + 10) + "px").style("top", (_event.pageY - 20) + "px"))
       .on("mouseout", function() {
           d3.select(this).style("filter", "none");
           tooltip.style("opacity", 0);
       });
}


// ==========================================
// 4. ЯДРО: КРОСС-ФИЛЬТРАЦИЯ И РЕНДЕР
// ==========================================

function renderDashboard() {
    if (!teamMasterLog.length) return;

    let dataForDecades = dashboardState.driver ? teamMasterLog.filter(d => d.driver_name === dashboardState.driver) : teamMasterLog;
    let dataForSeasons = dataForDecades;
    if (dashboardState.decade) dataForSeasons = dataForSeasons.filter(d => d.decade === dashboardState.decade);

    let dataForDrivers = teamMasterLog;
    if (dashboardState.decade) dataForDrivers = dataForDrivers.filter(d => d.decade === dashboardState.decade);
    if (dashboardState.season) dataForDrivers = dataForDrivers.filter(d => d.year === dashboardState.season);

    let fullyFilteredData = dataForDrivers;
    if (dashboardState.driver) fullyFilteredData = fullyFilteredData.filter(d => d.driver_name === dashboardState.driver);

    const activeColor = (dashboardState.driver || dashboardState.decade || dashboardState.season) ? currentTeamColors.sec : currentTeamColors.main;

    // 1. KPI
    const totalWins = d3.sum(fullyFilteredData, d => d.position === 1 ? 1 : 0);
    const totalPodiums = d3.sum(fullyFilteredData, d => (d.position >= 1 && d.position <= 3) ? 1 : 0);
    const finishes = d3.sum(fullyFilteredData, d => d.status_category === 'Финиш' ? 1 : 0);
    const finishRate = fullyFilteredData.length > 0 ? Math.round((finishes / fullyFilteredData.length) * 100) : 0;
    
    animateNumber("#val-wins", totalWins, activeColor);
    animateNumber("#val-podiums", totalPodiums, activeColor);
    animateNumber("#val-finish", finishRate, activeColor, "%");

    // 2. Десятилетия
    const winsByDecade = d3.rollup(dataForDecades.filter(d => d.position === 1), v => v.length, d => d.decade);
    const historyWinsData = Array.from(winsByDecade, ([decade, wins]) => ({ decade: decade.toString(), wins })).sort((a,b) => a.decade - b.decade);
    drawHistoryWinsChart(historyWinsData, currentTeamColors.main);

    if (dashboardState.decade) {
        d3.selectAll("#wins-chart rect").style("opacity", 0.3);
        d3.select(`#dec-${dashboardState.decade}`).style("opacity", 1).attr("fill", currentTeamColors.sec);
    }

    // 3. Сезоны
    const pointsByYear = d3.rollup(dataForSeasons, v => d3.sum(v, d => d.points || 0), d => d.year);
    const historyPointsData = Array.from(pointsByYear, ([year, points]) => ({ year, points })).sort((a,b) => a.year - b.year);
    drawHistoryPointsChart(historyPointsData, currentTeamColors.main);

    if (dashboardState.season) {
        d3.selectAll("#points-chart circle").style("opacity", 0.3);
        d3.select(`#sea-${dashboardState.season}`).style("opacity", 1).attr("stroke", currentTeamColors.sec).attr("fill", currentTeamColors.sec);
    }

    // 4. Пилоты
    const driversRollup = d3.rollup(dataForDrivers, 
        v => ({ total_points: d3.sum(v, d => d.points || 0), wins: d3.sum(v, d => d.position === 1 ? 1 : 0) }), d => d.driver_name
    );
    let driversData = Array.from(driversRollup, ([driver_name, stats]) => ({
        driver_name, total_points: stats.total_points, wins: stats.wins
    })).sort((a, b) => b.total_points - a.total_points).slice(0, 10);
    drawDriversChart(driversData, currentTeamColors.main);

    if (dashboardState.driver) {
        d3.selectAll("#drivers-chart rect").style("opacity", 0.3);
        d3.select(`#bar-${dashboardState.driver.replace(/\s+/g, '-')}`).style("opacity", 1).attr("fill", currentTeamColors.sec);
    }

    // 5. Трассы
    const tracksRollup = d3.rollup(fullyFilteredData,
        v => ({ wins: d3.sum(v, d => d.position === 1 ? 1 : 0), podiums: d3.sum(v, d => (d.position >= 1 && d.position <= 3) ? 1 : 0) }), d => d.circuit_name
    );
    let tracksData = Array.from(tracksRollup, ([circuit_name, stats]) => ({ circuit_name, wins: stats.wins, podiums: stats.podiums }));
    drawTopTracksChart(tracksData, activeColor);

    // 6. Надежность
    const relSummary = [ { status_category: "Финиш", total: 0 }, { status_category: "Технический сход", total: 0 }, { status_category: "Авария", total: 0 } ];
    fullyFilteredData.forEach(row => { const cat = relSummary.find(c => c.status_category === row.status_category); if (cat) cat.total += 1; });
    drawReliabilityDonut(relSummary, activeColor);
    
    animateNumber("#r-starts", fullyFilteredData.length, "#fff");
    animateNumber("#r-finishes", relSummary[0].total, activeColor);
    animateNumber("#r-mech", relSummary[1].total, "#8a8a9d");
    animateNumber("#r-crash", relSummary[2].total, "#ff2a2a");

    // 7. Тексты
    const titles = document.querySelectorAll(".header-titles h2");
    if (titles.length >= 4) {
        if (dashboardState.driver) {
             titles[2].innerHTML = `ГЕОГРАФИЯ ДОМИНАЦИИ <span style="color:${currentTeamColors.sec}; text-transform:none;">(${dashboardState.driver})</span>`;
             titles[3].innerHTML = `PIT WALL <span style="color:${currentTeamColors.sec}; text-transform:none;">(${dashboardState.driver})</span>`;
        } else {
             titles[2].innerHTML = `ГЕОГРАФИЯ ДОМИНАЦИИ: АНАЛИЗ ТРАСС`;
             titles[3].innerHTML = `PIT WALL: НАДЕЖНОСТЬ БОЛИДОВ`;
        }
    }

    updateTrackDetails()
}

// ==========================================
// 4.5. ЛОГИКА ДУЭЛЕЙ И ДЕТАЛИЗАЦИИ ТРАСС
// ==========================================

// ==========================================
// ГЕНЕРАТОР КАСТОМНЫХ СЕЛЕКТОРОВ (GLASSMORPHISM)
// ==========================================
function buildCustomSelect(selectId) {
    const nativeSelect = document.getElementById(selectId);
    if (!nativeSelect) return;

    // Если кастомный селектор уже отрисован (при смене команды) — удаляем старый
    let existingWrapper = nativeSelect.nextElementSibling;
    if (existingWrapper && existingWrapper.classList.contains('custom-select-wrapper')) {
        existingWrapper.remove();
    }

    // Прячем системный уродливый селектор
    nativeSelect.style.display = 'none';

    // Создаем обертку
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';

    // Создаем кнопку-триггер
    const trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger';
    const selectedText = nativeSelect.options.length > 0 ? nativeSelect.options[nativeSelect.selectedIndex].text : 'Выберите...';
    trigger.innerHTML = `<span>${selectedText}</span> <span>▼</span>`;
    
    // Создаем выпадающий список
    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'custom-options';

    // Переносим опции из стандартного списка в кастомный
    Array.from(nativeSelect.options).forEach((option, index) => {
        const customOpt = document.createElement('div');
        customOpt.className = 'custom-option';
        if (index === nativeSelect.selectedIndex) customOpt.classList.add('selected');
        customOpt.textContent = option.text;

        // Обработка клика по опции
        customOpt.addEventListener('click', function(e) {
            e.stopPropagation();
            
            // 1. Меняем значение в оригинальном скрытом селекторе
            nativeSelect.selectedIndex = index;
            // 2. Инициируем событие change, чтобы графики перерисовались
            nativeSelect.dispatchEvent(new Event('change'));
            
            // 3. Обновляем текст на кнопке
            trigger.querySelector('span').textContent = option.text;
            
            // 4. Перевешиваем класс selected
            optionsContainer.querySelectorAll('.custom-option').forEach(el => el.classList.remove('selected'));
            this.classList.add('selected');

            // 5. Закрываем список
            wrapper.classList.remove('open');
        });
        
        optionsContainer.appendChild(customOpt);
    });

    // Открытие/закрытие по клику на триггер
    trigger.addEventListener('click', function(e) {
        e.stopPropagation();
        // Закрываем другие открытые селекторы
        document.querySelectorAll('.custom-select-wrapper').forEach(w => {
            if (w !== wrapper) w.classList.remove('open');
        });
        wrapper.classList.toggle('open');
    });

    wrapper.appendChild(trigger);
    wrapper.appendChild(optionsContainer);
    
    // Вставляем кастомный селектор сразу после оригинального
    nativeSelect.parentNode.insertBefore(wrapper, nativeSelect.nextSibling);
}

// Закрываем списки при клике в пустую область экрана
document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
});


function initSelectsAndDetails() {
    if (!teamMasterLog.length) return;

    const d1Select = document.getElementById("driver1-select");
    const d2Select = document.getElementById("driver2-select");
    const trackSelect = document.getElementById("track-select");

    // Очищаем списки перед новым заполнением
    d1Select.innerHTML = ""; 
    d2Select.innerHTML = ""; 
    trackSelect.innerHTML = "";

    // 1. Заполняем списки пилотов (с фильтром больше 5 гонок)
    const driverCounts = d3.rollup(teamMasterLog, v => v.length, d => d.driver_name);
    
    let popularDrivers = Array.from(driverCounts)
        .filter(([driver, count]) => count > 5) // Убираем резервистов (5 и меньше гонок)
        .map(([driver]) => driver)
        .sort();

    // Если у команды короткая история, показываем всех
    if (popularDrivers.length === 0) {
        popularDrivers = Array.from(driverCounts.keys()).sort();
    }

    popularDrivers.forEach(driver => {
        d1Select.add(new Option(driver, driver));
        d2Select.add(new Option(driver, driver));
    });

    // Ставим разных пилотов по умолчанию (если их больше одного)
    if (popularDrivers.length > 1) {
        d1Select.selectedIndex = 0;
        d2Select.selectedIndex = 1;
    }

    // 2. Заполняем список трасс (с фильтром от 10 гонок / ~20 записей болидов)
    const trackCounts = d3.rollup(teamMasterLog, v => v.length, d => d.circuit_name);
    
    let popularTracks = Array.from(trackCounts)
        .filter(([track, count]) => count >= 20) // Больше 20 заездов машин
        .map(([track]) => track)
        .sort();

    // Защита для новых команд
    if (popularTracks.length === 0) {
        popularTracks = Array.from(trackCounts.keys()).sort();
    }

    popularTracks.forEach(track => {
        trackSelect.add(new Option(track, track));
    });

    // 3. Вешаем обработчики кликов (когда пользователь выбирает из списка)
    d1Select.addEventListener("change", updateDuelStats);
    d2Select.addEventListener("change", updateDuelStats);
    trackSelect.addEventListener("change", updateTrackDetails);

    // 4. Запускаем первый расчет, чтобы заполнить нули актуальными цифрами
    updateDuelStats();
    updateTrackDetails();

    // 5. Превращаем стандартные списки в кастомные (стеклянные)
    buildCustomSelect("driver1-select");
    buildCustomSelect("driver2-select");
    buildCustomSelect("track-select");
}

function updateDuelStats() {
    const driver1 = document.getElementById("driver1-select").value;
    const driver2 = document.getElementById("driver2-select").value;

    const calcStats = (driverName, prefix) => {
        const driverData = teamMasterLog.filter(d => d.driver_name === driverName);
        
        const wins = d3.sum(driverData, d => Number(d.position) === 1 ? 1 : 0);
        const podiums = d3.sum(driverData, d => (Number(d.position) >= 1 && Number(d.position) <= 3) ? 1 : 0);
        const poles = d3.sum(driverData, d => Number(d.grid) === 1 ? 1 : 0); 
        const points = d3.sum(driverData, d => Number(d.points) || 0); // Добавили подсчет очков
        const races = driverData.length;

        animateNumber(`#${prefix}-races`, races, "#fff");
        animateNumber(`#${prefix}-wins`, wins, currentTeamColors.main);
        animateNumber(`#${prefix}-podiums`, podiums, "#fff");
        animateNumber(`#${prefix}-poles`, poles, "#8a8a9d");

        // Отдаем в радар 5 метрик для красивого пятиугольника!
        return { name: driverName, "Гонки": races, "Очки": points, "Победы": wins, "Подиумы": podiums, "Поулы": poles };
    };

    const d1StatsObj = calcStats(driver1, "d1");
    const d2StatsObj = calcStats(driver2, "d2");
    
    drawRadarChart(d1StatsObj, d2StatsObj, currentTeamColors.main, currentTeamColors.sec);
}

function updateTrackDetails() {
    const trackSelect = document.getElementById("track-select");
    if (!trackSelect) return;
    const trackName = trackSelect.value;
    
    // Сначала берем гонки только на выбранной трассе
    let trackData = teamMasterLog.filter(d => d.circuit_name === trackName);

    // ВАЖНО: Применяем глобальные кросс-фильтры дашборда
    if (dashboardState.decade) trackData = trackData.filter(d => d.decade === dashboardState.decade);
    if (dashboardState.season) trackData = trackData.filter(d => d.year === dashboardState.season);
    if (dashboardState.driver) trackData = trackData.filter(d => d.driver_name === dashboardState.driver);

    // Считаем метрики с учетом фильтров
    const wins = d3.sum(trackData, d => Number(d.position) === 1 ? 1 : 0);
    const podiums = d3.sum(trackData, d => (Number(d.position) >= 1 && Number(d.position) <= 3) ? 1 : 0);
    const winRate = trackData.length > 0 ? Math.round((wins / trackData.length) * 100) : 0;

    document.getElementById("track-country").textContent = trackName;

    // Если активен фильтр — подсвечиваем цифры вторичным цветом (например, желтым у Феррари)
    const activeColor = (dashboardState.driver || dashboardState.decade || dashboardState.season) ? currentTeamColors.sec : currentTeamColors.main;

    animateNumber("#t-races", trackData.length, "#fff");
    animateNumber("#t-wins", wins, activeColor);
    animateNumber("#t-podiums", podiums, "#fff");
    animateNumber("#t-rate", winRate, activeColor, "%");
}

// ==========================================
// 5. ЗАГРУЗКА ДАННЫХ (API)
// ==========================================

async function fetchTeamData(teamName) {
    const ui = teamUI[teamName];
    dashboardState.team = teamName;
    currentTeamColors = ui.colors;
    dashboardState.decade = null;
    dashboardState.season = null;
    dashboardState.driver = null;

    document.querySelectorAll('.cyber-header').forEach(header => header.style.borderLeftColor = ui.colors.main);
    d3.select("#sub-wins").text(ui.subWins).style("color", ui.colors.main);
    d3.select("#sub-podiums").text(ui.subPodiums).style("color", ui.colors.main);
    d3.selectAll(".team-kpi-card").transition().duration(500).style("border-top-color", ui.colors.main);

    const { data: kpiData } = await supabaseClient.schema('f1').from('Team_KPI_Summary').select('championships').eq('team_name', teamName).maybeSingle(); 
    if (kpiData) animateNumber("#val-champs", kpiData.championships || 0, ui.colors.main);

    const { data, error } = await supabaseClient.schema('f1').from('Team_Master_Log').select('*').eq('team_name', teamName).limit(10000);
    if (error) { console.error("Ошибка загрузки:", error); return; }
    
    teamMasterLog = data || [];
    initSelectsAndDetails(); // <--- ДОБАВЬ ВОТ ЭТУ СТРОКУ
    renderDashboard();
}


// ==========================================
// 6. ИНИЦИАЛИЗАЦИЯ
// ==========================================

async function initDashboard() {
    console.log("Запуск F1 Analytics Dashboard...");
    fetchTeamData("Ferrari"); 
}

document.addEventListener('DOMContentLoaded', () => {
    initDashboard();
    const teamButtons = document.querySelectorAll('.team-btn');
    teamButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            teamButtons.forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            fetchTeamData(e.target.innerText); 
        });
    });
});