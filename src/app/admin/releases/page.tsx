import {CatalogueList} from "@/components/catalogue-list";
export default async function Page({searchParams}:PageProps<"/admin/releases">) {return <CatalogueList kind="releases" params={await searchParams}/>;}
