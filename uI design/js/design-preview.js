/* Standalone design preview. All records below are fictional and stay in memory. */
(function () {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
  const records = [
    ['Jordan Lee', 'S1021', 'Capstone I', 'Present', 'Face Check-In'],
    ['Avery Morgan', 'S1022', 'Capstone I', 'Late', 'Face Check-In'],
    ['Casey Rivera', 'S1023', 'Capstone I', 'Absent', 'No Check-In'],
    ['Taylor Brooks', 'S1024', 'Capstone I', 'Present', 'Instructor Override'],
    ['Riley Chen', 'S1025', 'Capstone I', 'Present', 'Face Check-In'],
    ['Alex Parker', 'S1026', 'Capstone I', 'Present', 'Face Check-In'],
    ['Sam Carter', 'S1027', 'Software Engineering', 'Late', 'Face Check-In'],
    ['Jamie Ellis', 'S1028', 'Software Engineering', 'Present', 'Face Check-In'],
    ['Drew Patel', 'S1029', 'Software Engineering', 'Absent', 'No Check-In'],
    ['Morgan Reed', 'S1030', 'Software Engineering', 'Present', 'Face Check-In'],
    ['Quinn Davis', 'S1031', 'Software Engineering', 'Present', 'Face Check-In'],
    ['Cameron Scott', 'S1032', 'Software Engineering', 'Present', 'Face Check-In'],
  ].map(([name, studentId, course, status, method]) => ({
    name, studentId, course, status, method, date: today,
  }));
  const pageSize = 10;
  let page = 1;
  let filtered = records.slice();

  byId('statTotal').textContent = records.length;
  ['Present', 'Late', 'Absent'].forEach((status) => {
    byId('stat' + status).textContent = records.filter((row) => row.status === status).length;
  });
  byId('firestoreStatus').textContent = 'Sample records for design preview';

  [...new Set(records.map((row) => row.course))].sort().forEach((course) => {
    const option = document.createElement('option');
    option.value = course;
    option.textContent = course;
    byId('courseFilter').appendChild(option);
  });

  function render() {
    const tbody = byId('attendanceTbody');
    tbody.replaceChildren();
    const start = (page - 1) * pageSize;
    filtered.slice(start, start + pageSize).forEach((record) => {
      const tr = document.createElement('tr');
      const values = [record.name, record.studentId, record.course,
        record.date, record.status, record.method];
      const classes = ['cell-name', 'cell-id', 'cell-course', 'cell-date',
        'cell-status', 'cell-notes'];
      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.className = classes[index];
        if (index === 4) {
          const badge = document.createElement('span');
          badge.className = 'status-badge status-' + record.status.toLowerCase();
          badge.textContent = value;
          td.appendChild(badge);
        } else {
          td.textContent = value;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'cell-notes';
      td.textContent = 'No attendance records match the current filters.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    byId('tableCount').textContent = filtered.length
      ? 'Showing ' + (start + 1) + '–' + Math.min(start + pageSize, filtered.length)
        + ' of ' + filtered.length
      : 'Showing 0 of 0';
    byId('paginationPrevBtn').disabled = page === 1;
    byId('paginationNextBtn').disabled = start + pageSize >= filtered.length;
  }

  function applyFilters() {
    const from = byId('dateFrom').value;
    const to = byId('dateTo').value;
    const status = byId('statusFilter').value;
    const course = byId('courseFilter').value;
    const search = byId('searchInput').value.trim().toLowerCase();
    filtered = records.filter((row) => (!from || row.date >= from)
      && (!to || row.date <= to)
      && (!status || row.status === status)
      && (!course || row.course === course)
      && [row.name, row.studentId, row.course].join(' ').toLowerCase().includes(search));
    page = 1;
    render();
  }

  byId('applyFilters').addEventListener('click', applyFilters);
  byId('courseFilter').addEventListener('change', applyFilters);
  byId('searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyFilters();
  });
  byId('clearFilters').addEventListener('click', () => {
    ['dateFrom', 'dateTo', 'statusFilter', 'courseFilter', 'searchInput'].forEach((id) => {
      byId(id).value = '';
    });
    applyFilters();
  });
  byId('paginationPrevBtn').addEventListener('click', () => {
    if (page > 1) { page -= 1; render(); }
  });
  byId('paginationNextBtn').addEventListener('click', () => {
    if (page * pageSize < filtered.length) { page += 1; render(); }
  });
  document.querySelectorAll('a[aria-disabled="true"]').forEach((link) => {
    link.addEventListener('click', (event) => event.preventDefault());
  });

  render();
})();
