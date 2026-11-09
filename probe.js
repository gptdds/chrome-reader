(() => {
const root = document.querySelector('extensions-manager').shadowRoot;
const list = root.querySelector('extensions-item-list');
return list ? Array.from(list.shadowRoot.querySelectorAll('extensions-item')).map(e=>({id:e.id,name:e.data?.name,state:e.data?.state,path:e.data?.path,errors:e.data?.runtimeErrors?.length})) : 'No list';
})()
