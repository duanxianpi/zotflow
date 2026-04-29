// @ts-ignore
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";

(async () => {
    const html = `<ul class="contains-task-list">
<li class="task-list-item"><input type="checkbox" checked disabled><span> </span><span>Done.</span></li>
<li class="task-list-item"><input type="checkbox" disabled><span> </span><span>Todo.</span></li>
</ul>`;
    const hast = unified().use(rehypeParse, { fragment: true }).parse(html);
    const mdast = await unified()
        .use(rehypeRemark)
        .run(hast as any);
    console.log(JSON.stringify(mdast, null, 2));
})();
