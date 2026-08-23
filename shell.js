(function () {
  'use strict';

  var page = document.body.getAttribute('data-page');
  document.querySelectorAll('.nav-link').forEach(function (link) {
    var target = link.getAttribute('data-nav');
    var active = target === page || (page === 'task' && target === 'tasks');
    if (active) link.setAttribute('aria-current', 'page');
  });

  var indicator = document.getElementById('repo-indicator');
  if (indicator) {
    var owner = localStorage.getItem('clipforge_owner') || '';
    var repo = localStorage.getItem('clipforge_repo') || '';
    indicator.textContent = owner && repo ? owner + '/' + repo : 'no repo configured';
  }
})();
